import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db.js";
import type { AuthUser } from "./auth.js";

type Movement = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
type Result = { status: "SUCCEEDED" | "FAILED"; error?: string; [key: string]: unknown };
type AccountRow = RowDataPacket & {
  id: string;
  owner_user_id: string;
  balance_cents: string;
};
type IdempotencyRow = RowDataPacket & {
  request_hash: string;
  http_status: number;
  response_json: Result;
};

const MAX_AMOUNT_CENTS = Number.MAX_SAFE_INTEGER;

function failure(error: string): Result {
  return { status: "FAILED", error };
}

function sendResult(res: Response, status: number, result: Result): void {
  res.status(status).json(result);
}

export async function executeMovement(
  req: Request,
  res: Response,
  movement: Movement
): Promise<void> {
  const actor = req.user as AuthUser;
  const key = req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 128) {
    sendResult(res, 400, failure("Provide an Idempotency-Key of 1–128 characters."));
    return;
  }

  const { accountId, destinationAccountId, amountCents } = req.body ?? {};
  const description =
    typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 255) : "";

  if (
    typeof accountId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(accountId) ||
    (movement === "TRANSFER" &&
      (typeof destinationAccountId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(destinationAccountId))) ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    sendResult(res, 400, failure("Provide valid account IDs and a positive amount in cents."));
    return;
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        movement,
        accountId,
        destinationAccountId: movement === "TRANSFER" ? destinationAccountId : null,
        amountCents,
        description
      })
    )
    .digest("hex");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      await connection.execute(
        `INSERT INTO idempotency_requests
         (actor_user_id, idempotency_key, request_hash, status)
         VALUES (?, ?, ?, 'PROCESSING')`,
        [actor.id, key, fingerprint]
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
      await connection.rollback();
      const [rows] = await pool.execute<IdempotencyRow[]>(
        `SELECT request_hash, http_status, response_json
         FROM idempotency_requests WHERE actor_user_id = ? AND idempotency_key = ?`,
        [actor.id, key]
      );
      const previous = rows[0];
      if (!previous) throw new Error("An idempotency key conflict had no stored result.");
      if (previous.request_hash !== fingerprint) {
        sendResult(res, 409, failure("This idempotency key was already used for a different request."));
        return;
      }
      res.setHeader("Idempotent-Replay", "true");
      sendResult(res, previous.http_status, previous.response_json);
      return;
    }

    const ids = movement === "TRANSFER"
      ? [accountId, destinationAccountId as string].sort()
      : [accountId];
    const accounts = new Map<string, AccountRow>();
    for (const id of ids) {
      const [rows] = await connection.execute<AccountRow[]>(
        "SELECT id, owner_user_id, balance_cents FROM accounts WHERE id = ? FOR UPDATE",
        [id]
      );
      if (rows[0]) accounts.set(rows[0].id, rows[0]);
    }
    const source = accounts.get(accountId);
    const destination =
      movement === "TRANSFER" ? accounts.get(destinationAccountId as string) : undefined;
    const balance = source ? Number(source.balance_cents) : 0;
    if (source && !Number.isSafeInteger(balance)) {
      throw new Error("Account balance is outside the safe integer range.");
    }

    let statusCode = 200;
    let result: Result;
    let refusal = "";

    if (!source) {
      statusCode = 404;
      result = failure("Account not found.");
      refusal = result.error as string;
    } else if (actor.role === "AUDITOR") {
      statusCode = 403;
      result = failure("Auditors have read-only access.");
      refusal = result.error as string;
    } else if (actor.role === "HOLDER" && source.owner_user_id !== actor.id) {
      statusCode = 403;
      result = failure("You are not authorized to use this account.");
      refusal = result.error as string;
    } else if (movement === "TRANSFER" && accountId === destinationAccountId) {
      statusCode = 400;
      result = failure("Choose a different destination account.");
      refusal = result.error as string;
    } else if (movement === "TRANSFER" && !destination) {
      statusCode = 404;
      result = failure("Destination account not found.");
      refusal = result.error as string;
    } else if (movement !== "DEPOSIT" && balance < amountCents) {
      statusCode = 422;
      result = failure("Insufficient funds.");
      refusal = result.error as string;
    } else {
      const transferId = randomUUID();
      await connection.execute(
        `INSERT INTO transfers
         (id, actor_user_id, source_account_id, destination_account_id,
          movement, amount_cents, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          transferId,
          actor.id,
          accountId,
          movement === "TRANSFER" ? destinationAccountId : null,
          movement,
          amountCents,
          description || movement.toLowerCase()
        ]
      );

      let sourceBalance = balance;
      if (movement === "DEPOSIT") {
        sourceBalance += amountCents;
        if (!Number.isSafeInteger(sourceBalance)) throw new Error("Account balance limit exceeded.");
        await connection.execute("UPDATE accounts SET balance_cents = ? WHERE id = ?", [
          sourceBalance,
          accountId
        ]);
        await connection.execute(
          `INSERT INTO ledger_entries
           (transfer_id, account_id, actor_user_id, entry_type, amount_cents,
            balance_after_cents, description)
           VALUES (?, ?, ?, 'CREDIT', ?, ?, ?)`,
          [transferId, accountId, actor.id, amountCents, sourceBalance, description || "deposit"]
        );
      } else {
        sourceBalance -= amountCents;
        const [debitUpdate] = await connection.execute<ResultSetHeader>(
          `UPDATE accounts SET balance_cents = balance_cents - ?
           WHERE id = ? AND balance_cents >= ?`,
          [amountCents, accountId, amountCents]
        );
        if (debitUpdate.affectedRows !== 1) throw new Error("The balance changed during the debit.");
        await connection.execute(
          `INSERT INTO ledger_entries
           (transfer_id, account_id, actor_user_id, entry_type, amount_cents,
            balance_after_cents, description)
           VALUES (?, ?, ?, 'DEBIT', ?, ?, ?)`,
          [transferId, accountId, actor.id, amountCents, sourceBalance, description || movement.toLowerCase()]
        );
        if (movement === "TRANSFER" && destination) {
          const destinationBalance = Number(destination.balance_cents) + amountCents;
          if (!Number.isSafeInteger(destinationBalance)) throw new Error("Destination balance limit exceeded.");
          await connection.execute("UPDATE accounts SET balance_cents = ? WHERE id = ?", [
            destinationBalance,
            destination.id
          ]);
          await connection.execute(
            `INSERT INTO ledger_entries
             (transfer_id, account_id, actor_user_id, entry_type, amount_cents,
              balance_after_cents, description)
             VALUES (?, ?, ?, 'CREDIT', ?, ?, ?)`,
            [
              transferId,
              destination.id,
              actor.id,
              amountCents,
              destinationBalance,
              description || "transfer received"
            ]
          );
        }
      }

      result = {
        status: "SUCCEEDED",
        transferId,
        movement,
        amountCents,
        sourceAccountId: accountId,
        destinationAccountId: destination?.id ?? null
      };
    }

    if (refusal && source) {
      await connection.execute(
        `INSERT INTO ledger_entries
         (account_id, actor_user_id, entry_type, amount_cents, balance_after_cents, description)
         VALUES (?, ?, 'REFUSED', ?, ?, ?)`,
        [accountId, actor.id, amountCents, balance, refusal]
      );
    }

    await connection.execute(
      `UPDATE idempotency_requests
       SET status = ?, http_status = ?, response_json = ?
       WHERE actor_user_id = ? AND idempotency_key = ?`,
      [
        result.status,
        statusCode,
        JSON.stringify(result),
        actor.id,
        key
      ]
    );
    await connection.commit();
    sendResult(res, statusCode, result);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
