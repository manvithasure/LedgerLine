import "dotenv/config";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { RowDataPacket } from "mysql2";
import { app } from "./app.js";
import { createToken } from "./auth.js";
import { pool } from "./db.js";

const userId = randomUUID();
const otherUserId = randomUUID();
const adminId = randomUUID();
const auditorId = randomUUID();
const sourceId = randomUUID();
const destinationId = randomUUID();
const openingTransferId = randomUUID();
const startingBalance = 10_000;
let baseUrl = "";
let server: ReturnType<typeof app.listen>;

const holderToken = createToken({
  id: userId,
  email: "test-holder@ledgerline.local",
  displayName: "Test Holder",
  role: "HOLDER"
});
const adminToken = createToken({
  id: adminId,
  email: "test-admin@ledgerline.local",
  displayName: "Test Admin",
  role: "ADMIN"
});
const otherToken = createToken({
  id: otherUserId,
  email: "other-holder@ledgerline.local",
  displayName: "Other Holder",
  role: "HOLDER"
});
const auditorToken = createToken({
  id: auditorId,
  email: "test-auditor@ledgerline.local",
  displayName: "Test Auditor",
  role: "AUDITOR"
});

async function postJson(token: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function getJson(token: string, path: string) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postMovement(
  token: string,
  key: string,
  path: string,
  body: Record<string, unknown>
) {
  const response = await fetch(`${baseUrl}/api/movements/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    replay: response.headers.get("Idempotent-Replay") === "true",
    body: await response.json() as { status: string; error?: string }
  };
}

before(async () => {
  await pool.execute(
    `INSERT INTO users (id, email, display_name, password_hash, role)
     VALUES (?, ?, 'Test Holder', ?, 'HOLDER'),
            (?, ?, 'Other Holder', ?, 'HOLDER'),
     (?, ?, 'Test Admin', ?, 'ADMIN'),
     (?, ?, 'Test Auditor', ?, 'AUDITOR')`,
    [
      userId,
      `${userId}@test.local`,
      "not-used-as-a-password-hash",
      otherUserId,
      `${otherUserId}@test.local`,
      "not-used-as-a-password-hash",
      adminId,
      `${adminId}@test.local`,
      "not-used-as-a-password-hash",
      auditorId,
      `${auditorId}@test.local`,
      "not-used-as-a-password-hash"
    ]
  );
  await pool.execute(
    `INSERT INTO accounts (id, name, owner_user_id, balance_cents)
     VALUES (?, 'Concurrent test source', ?, ?), (?, 'Concurrent test destination', ?, 0)`,
    [sourceId, userId, startingBalance, destinationId, adminId]
  );
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO transfers
       (id, actor_user_id, source_account_id, movement, amount_cents, description)
       VALUES (?, ?, ?, 'DEPOSIT', ?, 'Test opening balance')`,
      [openingTransferId, adminId, sourceId, startingBalance]
    );
    await connection.execute(
      `INSERT INTO ledger_entries
       (transfer_id, account_id, actor_user_id, entry_type, amount_cents,
        balance_after_cents, description)
       VALUES (?, ?, ?, 'CREDIT', ?, ?, 'Test opening balance')`,
      [openingTransferId, sourceId, adminId, startingBalance, startingBalance]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("concurrent withdrawals cannot spend the same balance twice", async () => {
  const body = { accountId: sourceId, amountCents: 7_000 };
  const results = await Promise.all([
    postMovement(holderToken, randomUUID(), "withdraw", body),
    postMovement(holderToken, randomUUID(), "withdraw", body)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 422]);

  const [accounts] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id = ?",
    [sourceId]
  );
  assert.equal(Number(accounts[0].balance_cents), 3_000);
  const [entries] = await pool.execute<RowDataPacket[]>(
    `SELECT entry_type, COUNT(*) AS count FROM ledger_entries
     WHERE account_id = ? GROUP BY entry_type`,
    [sourceId]
  );
  assert.equal(Number(entries.find((entry) => entry.entry_type === "DEBIT")?.count), 1);
  assert.equal(Number(entries.find((entry) => entry.entry_type === "REFUSED")?.count), 1);
});

test("same idempotency key and payload transfers only once", async () => {
  const [beforeRows] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id IN (?, ?) ORDER BY id",
    [sourceId, destinationId]
  );
  const beforeTotal = beforeRows.reduce((total, row) => total + Number(row.balance_cents), 0);
  const key = randomUUID();
  const body = { accountId: sourceId, destinationAccountId: destinationId, amountCents: 500 };
  const results = await Promise.all([
    postMovement(holderToken, key, "transfer", body),
    postMovement(holderToken, key, "transfer", body)
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 2);
  assert.equal(results.filter((result) => result.replay).length, 1);
  const changedPayload = await postMovement(holderToken, key, "transfer", {
    ...body,
    amountCents: 501
  });
  assert.equal(changedPayload.status, 409);

  const [afterRows] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id IN (?, ?) ORDER BY id",
    [sourceId, destinationId]
  );
  const afterTotal = afterRows.reduce((total, row) => total + Number(row.balance_cents), 0);
  assert.equal(afterTotal, beforeTotal);

  const [transfers] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM transfers
     WHERE actor_user_id = ? AND source_account_id = ? AND amount_cents = 500`,
    [userId, sourceId]
  );
  assert.equal(Number(transfers[0].count), 1);
});

test("an account holder cannot move another holder's money", async () => {
  const [beforeRows] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id = ?",
    [sourceId]
  );
  const response = await postMovement(
    otherToken,
    randomUUID(),
    "withdraw",
    { accountId: sourceId, amountCents: 100 }
  );
  assert.equal(response.status, 403);

  const [afterRows] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id = ?",
    [sourceId]
  );
  assert.equal(Number(afterRows[0].balance_cents), Number(beforeRows[0].balance_cents));
  const [refusals] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM ledger_entries
     WHERE account_id = ? AND actor_user_id = ? AND entry_type = 'REFUSED'`,
    [sourceId, otherUserId]
  );
  assert.equal(Number(refusals[0].count), 1);
});

test("ledger entries cannot be edited or deleted", async () => {
  const [entries] = await pool.execute<RowDataPacket[]>(
    "SELECT id FROM ledger_entries WHERE account_id = ? LIMIT 1",
    [sourceId]
  );
  assert.ok(entries[0]);
  await assert.rejects(
    pool.execute("UPDATE ledger_entries SET description = 'tampered' WHERE id = ?", [entries[0].id]),
    /append-only/i
  );
  await assert.rejects(
    pool.execute("DELETE FROM ledger_entries WHERE id = ?", [entries[0].id]),
    /append-only/i
  );
});

test("administrator can create users but holders cannot", async () => {
  const newEmail = `${randomUUID()}@test.local`;
  const payload = {
    email: newEmail,
    displayName: "Created Test Holder",
    password: "A-strong-test-password",
    role: "HOLDER"
  };
  const forbidden = await postJson(holderToken, "/users", payload);
  assert.equal(forbidden.status, 403);

  const created = await postJson(adminToken, "/users", payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.email, newEmail);

  const [users] = await pool.execute<RowDataPacket[]>(
    "SELECT password_hash FROM users WHERE email = ?",
    [newEmail]
  );
  assert.ok(users[0].password_hash !== payload.password);
  assert.ok(String(users[0].password_hash).startsWith("$2"));
});

test("administrator deposits are balanced while auditors remain read-only", async () => {
  const [beforeRows] = await pool.execute<RowDataPacket[]>(
    "SELECT SUM(balance_cents) AS total FROM accounts"
  );
  const beforeTotal = Number(beforeRows[0].total);
  const auditorAttempt = await postMovement(
    auditorToken,
    randomUUID(),
    "withdraw",
    { accountId: sourceId, amountCents: 100 }
  );
  assert.equal(auditorAttempt.status, 403);

  const adminDeposit = await postMovement(
    adminToken,
    randomUUID(),
    "deposit",
    { accountId: sourceId, amountCents: 250 }
  );
  assert.equal(adminDeposit.status, 200);

  const [afterRows] = await pool.execute<RowDataPacket[]>(
    "SELECT SUM(balance_cents) AS total FROM accounts"
  );
  assert.equal(Number(afterRows[0].total) - beforeTotal, 250);
});

test("holder can make a demo deposit only into their own account", async () => {
  const [beforeRows] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id = ?",
    [sourceId]
  );
  const beforeBalance = Number(beforeRows[0].balance_cents);

  const denied = await postMovement(
    otherToken,
    randomUUID(),
    "deposit",
    { accountId: sourceId, amountCents: 75 }
  );
  assert.equal(denied.status, 403);

  const deposited = await postMovement(
    holderToken,
    randomUUID(),
    "deposit",
    { accountId: sourceId, amountCents: 125 }
  );
  assert.equal(deposited.status, 200);

  const [afterRows] = await pool.execute<RowDataPacket[]>(
    "SELECT balance_cents FROM accounts WHERE id = ?",
    [sourceId]
  );
  assert.equal(Number(afterRows[0].balance_cents), beforeBalance + 125);
  const [entries] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM ledger_entries
     WHERE account_id = ? AND actor_user_id = ? AND entry_type = 'CREDIT' AND amount_cents = 125`,
    [sourceId, userId]
  );
  assert.equal(Number(entries[0].count), 1);
});

test("holders only see their own account while auditors can read all statements", async () => {
  const holderAccounts = await getJson(holderToken, "/accounts");
  assert.equal(holderAccounts.status, 200);
  assert.deepEqual(
    (holderAccounts.body.accounts as Array<{ id: string }>).map((account) => account.id),
    [sourceId]
  );

  const holderStatement = await getJson(otherToken, `/accounts/${sourceId}/statement`);
  assert.equal(holderStatement.status, 404);
  const auditorStatement = await getJson(auditorToken, `/accounts/${sourceId}/statement`);
  assert.equal(auditorStatement.status, 200);
  assert.ok(Array.isArray(auditorStatement.body.entries));
});

test("public registration creates only a holder, and admin can provision their account", async () => {
  const email = `${randomUUID()}@test.local`;
  const registered = await postJson("", "/auth/register", {
    email,
    displayName: "Self Registered Holder",
    password: "A-strong-registration-password",
    role: "ADMIN"
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.role, "HOLDER");
  assert.equal(registered.body.email, email);

  const duplicate = await postJson("", "/auth/register", {
    email,
    displayName: "Another Name",
    password: "A-strong-registration-password"
  });
  assert.equal(duplicate.status, 409);

  const invalidPassword = await postJson("", "/auth/register", {
    email: `${randomUUID()}@test.local`,
    displayName: "Weak Password",
    password: "short"
  });
  assert.equal(invalidPassword.status, 400);

  const [newUsers] = await pool.execute<RowDataPacket[]>(
    "SELECT id, role, password_hash FROM users WHERE email = ?",
    [email]
  );
  assert.equal(newUsers[0].role, "HOLDER");
  assert.notEqual(newUsers[0].password_hash, "A-strong-registration-password");
  const [accountsBeforeProvisioning] = await pool.execute<RowDataPacket[]>(
    "SELECT id FROM accounts WHERE owner_user_id = ?",
    [newUsers[0].id]
  );
  assert.equal(accountsBeforeProvisioning.length, 0);

  const adminCreatesAccount = await postJson(adminToken, "/accounts", {
    name: "Registered holder account",
    ownerUserId: newUsers[0].id
  });
  assert.equal(adminCreatesAccount.status, 201);
  assert.equal(adminCreatesAccount.body.balanceCents, 0);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "A-strong-registration-password" })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json() as { token: string };
  const holderAccounts = await getJson(loginBody.token, "/accounts");
  assert.equal(holderAccounts.status, 200);
  assert.equal((holderAccounts.body.accounts as Array<{ id: string }>).length, 1);
});

test("malformed registration JSON returns a clear client error", async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"email":'
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "The request data is invalid. Check the form and try again."
  });
});
