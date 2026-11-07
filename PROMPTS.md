# AI build log

Entries were written during development. Each entry links to the separate file commit that records the corresponding implementation or verification.

## 2026-11-06 — Choosing a local stack

- **Asked:** Build the LedgerLine assignment with React, Node, Express, and MongoDB; user also has MySQL locally.
- **Produced:** A proposal to use MySQL transactions and row-level locking because both database services are installed and running.
- **What needed checking:** MongoDB Compass alone would not prove transaction-ready replica-set configuration. Local MySQL is already running and InnoDB transactions fit the stated concurrency requirements.
- **What I did instead:** Chose the installed MySQL service for the transactional API and kept the React/Express stack. User was told this before implementation.
- **Commit:** [9c34a9b](https://github.com/manvithasure/LedgerLine/commit/9c34a9b) — app setup and selected dependencies.

## 2026-11-06 — Transfer integrity and lock ordering

- **Asked:** Implement the transfer path with atomic account updates and concurrency safety.
- **Produced:** A transaction that locks source and destination account rows in sorted ID order, verifies authorization and available funds, writes the debit/credit and ledger rows, then commits.
- **What needed checking:** A balance check alone would be unsafe under concurrent withdrawals. The debit must happen under the same row lock and transaction, not in a separate request step.
- **What I did instead:** Kept both the in-transaction check and a conditional `balance_cents >= amount` debit update; added a concurrent-withdrawal integration test.
- **Commit:** [0441bdb](https://github.com/manvithasure/LedgerLine/commit/0441bdb) — atomic movement implementation.

## 2026-11-06 — Idempotency and concurrent retry

- **Asked:** Make repeated money requests return the original result without posting twice.
- **Produced:** A unique `(actor_user_id, idempotency_key)` record inserted and completed in the movement transaction, with a SHA-256 request fingerprint.
- **What needed checking:** A duplicate key must be read only after the winning transaction commits, and a key with a different payload must not silently replay an unrelated result.
- **What I did instead:** On duplicate insertion, roll back the losing transaction, compare the stored request hash, return 409 on mismatch, and replay the stored response on a match. Added a concurrent replay test.
- **Commit:** [0441bdb](https://github.com/manvithasure/LedgerLine/commit/0441bdb) — transactional idempotency implementation.

## 2026-11-06 — Append-only audit records

- **Asked:** Record postings, refused attempts, resulting balances, and the initiating user.
- **Produced:** A ledger table with debit, credit, and refusal entries, plus MySQL triggers that reject update/delete operations.
- **What needed checking:** Application code alone cannot guarantee append-only behavior if a direct SQL update is possible.
- **What I did instead:** Added database triggers and documented that a database owner can still disable them; production needs a restricted database user and independent audit monitoring.
- **Commit:** [1403768](https://github.com/manvithasure/LedgerLine/commit/1403768) — append-only schema triggers.

## 2026-11-06 — Authentication and account access

- **Asked:** Add administrator, account-holder, and read-only auditor roles.
- **Produced:** JWT login, server-side role checks, holder ownership checks, a separate recipient list, and role-aware account statements.
- **What needed checking:** UI-only hiding of actions does not protect an API from direct calls. Admin-only deposits must be enforced at the server operation boundary.
- **What I did instead:** Enforced movement permissions in the backend transaction and added a cross-user authorization test; documented the admin’s broader privileges.
- **Commit:** [14f939c](https://github.com/manvithasure/LedgerLine/commit/14f939c) — role middleware; [31b8188](https://github.com/manvithasure/LedgerLine/commit/31b8188) — role-aware API.

## 2026-11-06 — Holder registration

- **Asked:** Add a registration page so more people can join the app.
- **Produced:** A public registration form and endpoint for holder accounts only, with hashed passwords and rate limiting.
- **What needed checking:** Letting the browser choose an admin/auditor role would allow privilege escalation; creating funded accounts automatically would also exceed the user's chosen onboarding policy.
- **What I did instead:** Restricted self-registration to `HOLDER`, created no account on signup, and required the administrator to create the account before the new holder can use LedgerLine. Added integration tests for privilege restriction, duplicate email, password hashing, login, and admin account provisioning.
- **Commit:** [31b8188](https://github.com/manvithasure/LedgerLine/commit/31b8188) — registration endpoint; [cb59546](https://github.com/manvithasure/LedgerLine/commit/cb59546) — integration tests.
