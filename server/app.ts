import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2";
import { createToken, requireAuth, requireRole } from "./auth.js";
import { pool } from "./db.js";
import { executeMovement } from "./movements.js";
import { createRateLimiter, isRateLimitStoreReady, rateLimitBackend } from "./rate-limit.js";

export const app = express();
const asyncHandler = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) => (req: express.Request, res: express.Response, next: express.NextFunction): void => {
  void handler(req, res, next).catch(next);
};
app.use(helmet());
const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  ...(process.env.WEB_ORIGIN ? [process.env.WEB_ORIGIN] : [])
]);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("This website origin is not allowed."));
    }
  })
);
app.use(express.json({ limit: "16kb" }));

app.get("/api/health", asyncHandler(async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
}));

app.get("/api/live", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/ready", asyncHandler(async (_req, res) => {
  let databaseReady = false;
  try {
    await pool.query("SELECT 1");
    databaseReady = true;
  } catch (error) {
    console.error("Database readiness check failed:", error);
  }

  const rateLimitReady = isRateLimitStoreReady();
  const ready = databaseReady && rateLimitReady;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "error",
    database: databaseReady ? "connected" : "unavailable",
    rateLimitStore: rateLimitReady ? rateLimitBackend : "unavailable"
  });
}));

app.post(
  "/api/auth/login",
  createRateLimiter(15 * 60 * 1000, 10),
  asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) {
      res.status(400).json({ error: "Enter your email and password." });
      return;
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, email, display_name, password_hash, role
       FROM users WHERE email = ?`,
      [email]
    );
    const account = rows[0];
    if (!account || !(await bcrypt.compare(password, account.password_hash))) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }

    const user = {
      id: account.id as string,
      email: account.email as string,
      displayName: account.display_name as string,
      role: account.role as "ADMIN" | "HOLDER" | "AUDITOR"
    };
    res.json({ token: createToken(user), user });
  })
);

app.post(
  "/api/auth/register",
  createRateLimiter(15 * 60 * 1000, 5),
  asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !displayName ||
      displayName.length > 120 ||
      password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      res.status(400).json({
        error: "Provide a valid email, display name, and password between 12 and 72 bytes."
      });
      return;
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      await pool.execute(
        "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'HOLDER')",
        [id, email, displayName, passwordHash]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
        return;
      }
      throw error;
    }
    res.status(201).json({
      id,
      email,
      displayName,
      role: "HOLDER",
      message: "Registration complete. An administrator must create your account before you can use LedgerLine."
    });
  })
);

app.use("/api", requireAuth);

app.get("/api/me", (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/accounts", asyncHandler(async (req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT a.id, a.name, a.owner_user_id, a.balance_cents, a.created_at,
            u.display_name AS owner_name
     FROM accounts a JOIN users u ON u.id = a.owner_user_id
     ${req.user?.role === "HOLDER" ? "WHERE a.owner_user_id = ?" : ""}
     ORDER BY a.created_at, a.id`,
    req.user?.role === "HOLDER" ? [req.user.id] : []
  );
  res.json({
    accounts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerName: row.owner_name,
      balanceCents: Number(row.balance_cents)
    }))
  });
}));

app.get("/api/recipients", asyncHandler(async (req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, name FROM accounts
     WHERE id NOT IN (SELECT id FROM accounts WHERE owner_user_id = ?)
     ORDER BY name`,
    [req.user!.id]
  );
  res.json({ recipients: rows });
}));

app.post("/api/accounts", requireRole("ADMIN"), asyncHandler(async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const ownerUserId = typeof req.body?.ownerUserId === "string" ? req.body.ownerUserId : "";
  if (!name || name.length > 120 || !ownerUserId) {
    res.status(400).json({ error: "Provide an account name and owner user ID." });
    return;
  }
  const id = randomUUID();
  const [owners] = await pool.execute<RowDataPacket[]>(
    "SELECT id FROM users WHERE id = ? AND role != 'AUDITOR'",
    [ownerUserId]
  );
  if (!owners[0]) {
    res.status(400).json({ error: "Choose an existing administrator or account holder." });
    return;
  }
  await pool.execute("INSERT INTO accounts (id, name, owner_user_id) VALUES (?, ?, ?)", [
    id,
    name,
    ownerUserId
  ]);
  res.status(201).json({ id, name, ownerUserId, balanceCents: 0 });
}));

app.get("/api/users", requireRole("ADMIN"), asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, email, display_name AS displayName, role FROM users ORDER BY email"
  );
  res.json({ users: rows });
}));

app.post("/api/users", requireRole("ADMIN"), asyncHandler(async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const requestedRole = req.body?.role;
  const role = (["ADMIN", "HOLDER", "AUDITOR"] as const).find(
    (candidate) => candidate === requestedRole
  );
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !displayName ||
    displayName.length > 120 ||
    password.length < 12 ||
    Buffer.byteLength(password, "utf8") > 72 ||
    !role
  ) {
    res.status(400).json({
      error: "Provide a valid email, display name, role, and password between 12 and 72 bytes."
    });
    return;
  }
  const id = randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await pool.execute(
      "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      [id, email, displayName, passwordHash, role]
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "A user with this email already exists." });
      return;
    }
    throw error;
  }
  res.status(201).json({ id, email, displayName, role });
}));

app.get("/api/accounts/:accountId/statement", asyncHandler(async (req, res) => {
  const [accounts] = await pool.execute<RowDataPacket[]>(
    `SELECT id, owner_user_id FROM accounts WHERE id = ?`,
    [req.params.accountId]
  );
  const account = accounts[0];
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  if (req.user?.role === "HOLDER" && account.owner_user_id !== req.user.id) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT e.id, e.transfer_id AS transferId, e.entry_type AS entryType,
            e.amount_cents AS amountCents, e.balance_after_cents AS balanceAfterCents,
            e.description, e.created_at AS createdAt, u.display_name AS actorName,
            u.email AS actorEmail
     FROM ledger_entries e JOIN users u ON u.id = e.actor_user_id
     WHERE e.account_id = ? ORDER BY e.id DESC LIMIT 250`,
    [req.params.accountId]
  );
  res.json({
    entries: rows.map((row) => ({
      ...row,
      amountCents: Number(row.amountCents),
      balanceAfterCents: Number(row.balanceAfterCents)
    }))
  });
}));

app.post("/api/movements/deposit", (req, res, next) => {
  void executeMovement(req, res, "DEPOSIT").catch(next);
});
app.post("/api/movements/withdraw", (req, res, next) => {
  void executeMovement(req, res, "WITHDRAWAL").catch(next);
});
app.post("/api/movements/transfer", (req, res, next) => {
  void executeMovement(req, res, "TRANSFER").catch(next);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestError = error as { status?: number; statusCode?: number; type?: string };
  if (requestError.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request data is invalid. Check the form and try again." });
    return;
  }
  if (requestError.type === "entity.too.large") {
    res.status(413).json({ error: "The request is too large." });
    return;
  }
  console.error("Request failed:", error);
  res.status(500).json({ error: "The request could not be completed. Please try again." });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

const clientDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
if (existsSync(resolve(clientDirectory, "assets"))) {
  app.use(express.static(clientDirectory));
  app.get("*", (_req, res) => {
    res.sendFile(resolve(clientDirectory, "index.html"));
  });
}
