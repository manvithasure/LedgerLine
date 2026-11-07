import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";

const demoUsers = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@ledgerline.local",
    displayName: "LedgerLine Admin",
    role: "ADMIN",
    password: "AdminPass123!"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    email: "holder@ledgerline.local",
    displayName: "Alex Holder",
    role: "HOLDER",
    password: "HolderPass123!"
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    email: "auditor@ledgerline.local",
    displayName: "Avery Auditor",
    role: "AUDITOR",
    password: "AuditorPass123!"
  }
] as const;

const accounts = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Alex's operating account",
    ownerId: demoUsers[1].id,
    initialBalanceCents: 2_500_000
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    name: "Demo Vendor",
    ownerId: demoUsers[0].id,
    initialBalanceCents: 0
  }
] as const;

async function seed(): Promise<void> {
  for (const user of demoUsers) {
    const passwordHash = await bcrypt.hash(user.password, 12);
    await pool.execute(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
                               password_hash = VALUES(password_hash),
                               role = VALUES(role)`,
      [user.id, user.email, user.displayName, passwordHash, user.role]
    );
  }

  for (const account of accounts) {
    await pool.execute(
      `INSERT IGNORE INTO accounts (id, name, owner_user_id, balance_cents)
       VALUES (?, ?, ?, 0)`,
      [account.id, account.name, account.ownerId]
    );
    if (account.initialBalanceCents === 0) continue;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Array<{ balance_cents: string } & import("mysql2").RowDataPacket>>(
        "SELECT balance_cents FROM accounts WHERE id = ? FOR UPDATE",
        [account.id]
      );
      const [entries] = await connection.execute<import("mysql2").RowDataPacket[]>(
        "SELECT id FROM ledger_entries WHERE account_id = ? LIMIT 1",
        [account.id]
      );
      if (rows[0] && Number(rows[0].balance_cents) === 0 && entries.length === 0) {
        const transferId = crypto.randomUUID();
        await connection.execute(
          `INSERT INTO transfers
           (id, actor_user_id, source_account_id, movement, amount_cents, description)
           VALUES (?, ?, ?, 'DEPOSIT', ?, 'Demo opening balance')`,
          [transferId, demoUsers[0].id, account.id, account.initialBalanceCents]
        );
        await connection.execute("UPDATE accounts SET balance_cents = ? WHERE id = ?", [
          account.initialBalanceCents,
          account.id
        ]);
        await connection.execute(
          `INSERT INTO ledger_entries
           (transfer_id, account_id, actor_user_id, entry_type, amount_cents,
            balance_after_cents, description)
           VALUES (?, ?, ?, 'CREDIT', ?, ?, 'Demo opening balance')`,
          [
            transferId,
            account.id,
            demoUsers[0].id,
            account.initialBalanceCents,
            account.initialBalanceCents
          ]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  console.log("Demo users and accounts are ready.");
}

seed()
  .catch((error: unknown) => {
    console.error("Could not seed LedgerLine:", error);
    process.exitCode = 1;
  })
  .finally(async () => pool.end());
