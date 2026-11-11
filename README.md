# LedgerLine

LedgerLine is a money-movement demo built with React, Express, and MySQL. It uses integer cents, InnoDB transactions, account row locks, idempotency keys, and an append-only ledger.

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

An internal transfer writes one debit and one equal credit, so it changes the total by zero. A refused attempt is a separate `REFUSED` ledger entry with no balance change. Local MySQL installs triggers that reject direct update/delete operations on ledger rows. TiDB does not support triggers, so its cloud runtime user is granted no `UPDATE` or `DELETE` permission on the ledger table.

## API summary

All endpoints other than health/readiness endpoints and `/api/auth/login` or `/api/auth/register` require `Authorization: Bearer <token>`.

| Endpoint | Access | Effect |
|---|---|---|
| `GET /api/health` | Public | Checks API/database availability; does not move money |
| `GET /api/live` | Public | Confirms the API process is responsive |
| `GET /api/ready` | Public | Confirms database and rate-limit store readiness |
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
2. Select it, then run `db\schema.sql` and `db\mysql-ledger-protection.sql` against it, in that order.
3. In a separate PowerShell window, set the database name for the test process and run:

   ```powershell
   $env:MYSQL_DATABASE = "ledgerline_test"
   npm test
   ```

The tests create disposable test users/accounts in that schema. They test two concurrent over-sized withdrawals, a concurrent duplicate transfer replay, transfer conservation, and cross-user account authorization.

## Deploying with Vercel and Render

The included `vercel.json` builds the React/Vite frontend as a static site. The included `render.yaml` deploys the Express API as a Render web service. The browser calls the API using `VITE_API_BASE_URL`, and the API only allows the configured `WEB_ORIGIN`.

The deployment files target a **no-cost demo** using Vercel Hobby, a Render Free web service, and TiDB Cloud Starter. Your PC's MySQL is local-only; it cannot be the database for the deployed app. Never send database passwords, admin passwords, or tokens in chat or commit them to Git.

The updated BalanceVault specification makes PostgreSQL with Prisma and database migrations mandatory. This repository still uses MySQL/TiDB because the project owner chose to keep the existing database for now. Therefore **the PostgreSQL/Prisma and Prisma-migration rubric requirements are not currently met**; `db/schema.sql` is an initialization schema, not a versioned Prisma migration, and the existing MySQL deployment configuration is not compliant with those requirements. Do not describe the project as fully aligned until a PostgreSQL/Prisma migration is implemented and verified.

Authentication rate limits use Redis across instances when `REDIS_URL` is configured. Production startup requires Redis; it fails rather than silently using per-process memory storage. Local development without `REDIS_URL` uses the in-memory limiter only. Configure a TLS Redis URL in Render's `REDIS_URL` environment variable before deploying; Render readiness checks include the configured rate-limit store.

Free services are not production banking infrastructure. Render Free services can sleep after 15 minutes without traffic and take about a minute to wake. TiDB Starter has monthly resource limits (currently 5 GiB row storage, 5 GiB columnar storage, and 50 million request units for the documented free allowance); when the quota is reached, new connections can be denied until reset. Do not add a payment method or increase the spending limit if you want to avoid charges. Check the [TiDB Starter plan](https://docs.pingcap.com/tidbcloud/select-cluster-tier/), [spend limits](https://docs.pingcap.com/tidbcloud/manage-serverless-spend-limit/), and [Render Free limitations](https://render.com/docs/free) before proceeding; free-tier policies can change.

### 1. Create the TiDB database

1. Sign in to [TiDB Cloud](https://tidbcloud.com/) and create a **TiDB Cloud Starter** cluster using its MySQL-compatible connection option. Save the connection details privately. TiDB requires TLS and uses port `4000`.
2. In TiDB's SQL editor, create the app database by running `CREATE DATABASE ledgerline;`, select `ledgerline`, then copy and run the contents of `db\schema.sql`. Do **not** run `db\mysql-ledger-protection.sql` on TiDB; it contains MySQL-only triggers.
3. Use the cluster admin to run `db\tidb-runtime-grants.sql` after replacing the username prefix, database name, and a newly generated password. To generate a SQL-literal-safe random password locally, run `node -p "require('node:crypto').randomBytes(32).toString('base64url')"` in PowerShell. Keep the filled-in SQL out of Git and delete the local filled-in copy afterward. This creates a separate app user with only the permissions the app needs; in particular, it cannot update or delete ledger rows. The admin connection is for setup only and must not be used by Render.
4. Create the Render service in the next step, then add all of that service's outbound IP ranges to the TiDB cluster's IP access list. For the one-time admin creation script later, temporarily allow your PC's current public IP too; remove it afterward. Do not use a public `0.0.0.0/0` rule.

### 2. Deploy the API to Render

1. In Render, choose **New → Blueprint**, connect the GitHub repository, and deploy using the included `render.yaml`. Keep the service on the **Free** plan.
2. During setup, enter the TiDB connection settings and restricted runtime-user credentials in Render's environment prompts:
   - `MYSQL_HOST`: TiDB endpoint hostname
   - `MYSQL_PORT`: `4000`
   - `MYSQL_USER`, `MYSQL_PASSWORD`: the restricted runtime user from the previous step
   - `MYSQL_DATABASE`: `ledgerline`
   - `MYSQL_SSL`: leave as `true`
   - `MYSQL_SSL_CA_BASE64`: leave blank unless TiDB explicitly supplies a CA certificate
   - `WEB_ORIGIN`: use `https://example.com` temporarily if Vercel is not deployed yet; replace it with the Vercel origin and redeploy after the frontend is ready
   - `JWT_SECRET`: generated by the Render blueprint; do not replace it with a public value
3. Configure `REDIS_URL` with the Redis provider's TLS connection URL before deployment. Wait for the Render service to be created, copy its outbound IP ranges from its dashboard, add them to TiDB's access list, and redeploy/restart if the initial health check failed before the IP rule was added. Check `https://<your-render-service>.onrender.com/api/ready` for a healthy API/database/rate-limit response.

### 3. Deploy the frontend to Vercel

1. In Vercel, choose **Add New → Project**, import the same GitHub repository, and leave the project root at the repository root.
2. Add the build environment variable `VITE_API_BASE_URL` with the Render service's HTTPS origin, for example `https://ledgerline-api.onrender.com` (no trailing slash), and deploy.
3. Copy the exact Vercel site origin, such as `https://your-project.vercel.app`, into Render's `WEB_ORIGIN`. Save and redeploy the Render service. Vite reads its API URL during build, so redeploy Vercel if you change `VITE_API_BASE_URL`.

### 4. Create the first admin

Never run `npm run seed` against the cloud database: it creates published demo accounts and passwords. Render Free does **not** provide Shell/SSH access, so create the first administrator from your Windows PC with the included `setup-cloud-admin.ps1` script:

1. Temporarily add your PC's current public IP to TiDB's IP access list.
2. In this repository folder, run `.\setup-cloud-admin.ps1`. Enter the TiDB host, port (`4000`), database (`ledgerline`), restricted runtime username/password, and a new admin email/name/password when prompted. Password prompts are hidden; the script builds the app and runs the one-time admin command without writing the cloud credentials to `.env` or source files.
3. Remove your PC's IP from the TiDB access list and keep only the Render outbound IP ranges.
4. Sign in on the Vercel site, then create account-holder users and accounts from the admin interface. Public registration only creates holder logins; it does not grant admin access or automatically create accounts.

See [TiDB connection instructions](https://docs.pingcap.com/tidbcloud/connect-to-tidb-cluster-serverless/) and [Render outbound IP addresses](https://render.com/docs/outbound-ip-addresses) for current provider UI details.

### Create the first production administrator

Do not run `npm run seed` against a public database: it installs published demo credentials. Instead, after the schema is installed, open the Render service's **Shell** and run the compiled one-time first-admin command. It only creates an administrator if none exists and never changes an existing user.

Enter values without saving them into the repository. In the Render Shell, use hidden password input:

```bash
read -r -p "Admin email: " BOOTSTRAP_ADMIN_EMAIL
read -r -p "Admin display name: " BOOTSTRAP_ADMIN_NAME
read -r -s -p "Admin password (12–72 bytes): " BOOTSTRAP_ADMIN_PASSWORD
echo
export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_PASSWORD
npm run create-admin
unset BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_PASSWORD
```

The password is not echoed or stored in source control. Keep it in your password manager. Sign in with this admin and create account-holder users/accounts through the UI. Public registration creates holder logins only; an administrator still needs to assign an account.

## Known limitations

This is a demonstration project, not production banking software. A live deployment still requires the user to create cloud services, configure their secrets/IP access, and verify the actual services. It has no email verification, password reset, multi-currency support, overdraft, reversal workflow, external payment rails, or backups/independent audit monitoring. It does not yet satisfy the newly-added PostgreSQL/Prisma requirement. The local demo credentials and opening balance are for local testing only. On TiDB, app-level ledger immutability depends on the restricted runtime user's grants; a cluster administrator can still change privileges or data.
