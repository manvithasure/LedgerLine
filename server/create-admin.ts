import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { beginTransaction, pool } from "./db.js";

async function createFirstAdmin(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const displayName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() ?? "";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !displayName ||
    displayName.length > 120 ||
    password.length < 12 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    throw new Error(
      "Set a valid BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, and BOOTSTRAP_ADMIN_PASSWORD (12–72 bytes)."
    );
  }

  const connection = await pool.getConnection();
  try {
    await beginTransaction(connection);
    const [existingAdmins] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1 FOR UPDATE"
    );
    if (existingAdmins.length > 0) {
      throw new Error("An administrator already exists. The first-admin command will not change existing users.");
    }

    const [existingEmail] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    if (existingEmail.length > 0) {
      throw new Error("This email is already registered. Choose another email for the first administrator.");
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await connection.execute(
      "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'ADMIN')",
      [randomUUID(), email, displayName, passwordHash]
    );
    await connection.commit();
    console.log("The first LedgerLine administrator was created.");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

createFirstAdmin()
  .catch((error: unknown) => {
    console.error("Could not create the first administrator:", error);
    process.exitCode = 1;
  })
  .finally(async () => pool.end());
