# LedgerLine

LedgerLine is a local money-movement demo built with React, Express, and MySQL. It uses integer cents, InnoDB transactions, account row locks, idempotency keys, and an append-only ledger.

## Run it on Windows

Requirements: Node.js 20+, and the MySQL 8 service already installed on this PC.

1. In PowerShell, from this project folder, run the setup script. It securely prompts for your local MySQL root password, creates the schema, and writes a local `.env` file with a generated JWT secret. The password is not added to source files or printed:

   ```powershell
   .\setup-local.ps1
   ```

   If PowerShell blocks the script, open PowerShell in this folder and run `Set-ExecutionPolicy -Scope Process Bypass`, then run it again. The change lasts only for that PowerShell window.

2. Install the JavaScript packages, then create the demo users and accounts:

   ```powershell
   npm install
   npm run seed
   ```

3. Start the app:

   ```powershell
   npm run dev
   ```

   Open `http://127.0.0.1:5173`.

The seed command creates these local-only demo logins:

| Role | Email | Password |
|---|---|---|
| Account holder | `holder@ledgerline.local` | `HolderPass123!` |
| Administrator | `admin@ledgerline.local` | `AdminPass123!` |
| Auditor | `auditor@ledgerline.local` | `AuditorPass123!` |

The account holder starts with ₹25,000. The demo vendor account starts at ₹0. New visitors can register as account holders from the sign-in page; registration never grants admin/auditor access and does not create an account. An administrator must create an account for the new user before they can use money-movement features. Once assigned an account, a holder can make a demo deposit into their own account. Demo deposits represent external incoming funds, so they increase the total-account-balance invariant and are recorded as ledger credits; no real payment is processed. The administrator can also create users, create accounts for existing non-auditors, and deposit external funds. Account holders can withdraw from their own accounts and transfer to other accounts. Auditors can view every account and statement but cannot initiate movements.

## Integrity model

Balances are stored as integer paise (`BIGINT`), never floating-point currency. A transfer starts an InnoDB transaction and locks its source and destination account rows in a stable ID order with `SELECT ... FOR UPDATE`. It checks authorization and available funds while those locks are held. Debit, credit, balance updates, transfer record, ledger entries, and idempotency result commit together or roll back together. The debit also has a conditional `balance_cents >= amount` update as a second server-side guard.

Each money-moving call requires an `Idempotency-Key`. The unique `(actor_user_id, idempotency_key)` row is written in the same transaction as the movement. A simultaneous duplicate waits for the first transaction, then returns its stored status and response without posting a second movement. Reusing the key with a different payload returns HTTP 409.

The conservation rule is:

```text
sum(account balances) = external deposits - external withdrawals
```

An internal transfer writes one debit and one equal credit, so it changes the total by zero. A refused attempt is a separate `REFUSED` ledger entry with no balance change. Database triggers reject direct update/delete operations on ledger rows.

## API summary

All endpoints other than `/api/health` and `/api/auth/login` require `Authorization: Bearer <token>`.

| Endpoint | Access | Effect |
|---|---|---|
| `GET /api/health` | Public | Checks API/database availability; does not move money |
| `POST /api/auth/login` | Public, rate-limited | Issues an 8-hour JWT; does not move money |
| `POST /api/auth/register` | Public, rate-limited | Creates a holder login only; account must be provisioned by admin |
| `GET /api/accounts` | Signed-in users | Holder sees own accounts; admin/auditor see all |
| `GET /api/recipients` | Signed-in users | Returns account names/IDs only, no balances |
| `GET /api/accounts/:id/statement` | Account owner, admin, auditor | Reads up to 250 newest ledger events |
| `POST /api/accounts` | Admin | Creates a zero-balance account for an existing non-auditor |
| `GET /api/users` | Admin | Lists users for account setup |
| `POST /api/users` | Admin | Creates an account, admin, or auditor user; passwords need at least 12 characters |
| `POST /api/movements/transfer` | Admin or authorized holder | Atomically debits source and credits destination |
| `POST /api/movements/withdraw` | Admin or authorized holder | Debits an account, treated as external money leaving |
| `POST /api/movements/deposit` | Admin or owning holder | Credits an authorized account as external money entering (demo only) |

Every movement request must contain an `Idempotency-Key` header and a JSON body with `accountId`, positive integer `amountCents`, and, for transfers, `destinationAccountId`. Optional `description` is recorded in the ledger.

## Tests

The integration tests issue real simultaneous HTTP requests and inspect committed MySQL balances. Run them against a separate test database so test ledger rows do not mix with demo data:

1. Create a schema named `ledgerline_test` in Workbench.
2. Select it, then run `db\schema.sql` against it.
3. In a separate PowerShell window, set the database name for the test process and run:

   ```powershell
   $env:MYSQL_DATABASE = "ledgerline_test"
   npm test
   ```

The tests create disposable test users/accounts in that schema. They test two concurrent over-sized withdrawals, a concurrent duplicate transfer replay, transfer conservation, and cross-user account authorization.

## Deploying with Vercel and Render

The included `vercel.json` builds the React/Vite frontend as a static site. The included `render.yaml` deploys the Express API as a Render web service. The browser calls the API using `VITE_API_BASE_URL`, and the API only allows the configured `WEB_ORIGIN`.

You also need a **managed, publicly reachable MySQL 8 database with TLS**. Your PC's MySQL server is not reachable by Vercel or Render, and Render's standard managed database offering is PostgreSQL, not MySQL. Use a managed MySQL provider of your choice and create an empty database. Keep its credentials private; do not put them in the repository. Do not use a local-only or ephemeral database for a deployed money ledger.

1. Push this project to a Git provider account you control.
2. Create the Render web service from the repository using the included `render.yaml`. In Render's environment settings, provide `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_PORT`, `MYSQL_SSL_CA_BASE64` (if the provider supplies a CA certificate), and `WEB_ORIGIN`. Set `MYSQL_SSL=true`. `JWT_SECRET` is generated by Render.
3. Use a secure MySQL client to connect to the cloud database and run `db\schema.sql`. Never run the demo `npm run seed` against a public production database: it creates known demo accounts and passwords. The API health check should report `database: connected`.
4. Create a Vercel project from the same repository using the root directory. Set `VITE_API_BASE_URL` to the Render API's HTTPS origin, for example `https://ledgerline-api.onrender.com`, and deploy. Vite reads this variable at build time.
5. Set Render's `WEB_ORIGIN` to the exact deployed Vercel origin (such as `https://your-project.vercel.app`), redeploy the API, and test login and all roles on the live site.

Render's free web service may sleep while idle. That can make the first request slow, so a paid always-on service is more appropriate for a responsive demonstration. Free-tier availability and managed MySQL pricing vary by provider and may change.

## Known limitations

This is a demonstration project, not production banking software. Deployment configuration is included, but a live deployment still requires a cloud MySQL provider, cloud schema setup, Vercel/Render accounts, and verification against the actual deployed services. It has no email verification, password reset, multi-currency support, overdraft, reversal workflow, external payment rails, or dedicated least-privilege database user. The demo credentials and opening balance are for local testing only. The database owner can still bypass triggers by changing the schema or disabling protections; production ledger storage would need restricted database privileges, backups, and independent tamper monitoring.
