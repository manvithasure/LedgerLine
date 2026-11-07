# Threat model

## Protected assets and invariant

Protected assets are account balances, account ownership, idempotency results, and the ledger audit trail. The server maintains non-negative account balances, requires an authorized actor for every movement, and ensures internal transfers sum to zero. Amounts are integer paise.

## Threats and mitigations

| Threat | Mitigation | Remaining risk |
|---|---|---|
| Two withdrawals both spend the same available funds | InnoDB transaction, `SELECT ... FOR UPDATE` on account rows, balance check under lock, and conditional debit update | Requires InnoDB and transactions to remain enabled |
| A transfer debits but fails before credit | Both balance updates, transfer record, ledger postings, and idempotency result share one transaction | Database durability/configuration is outside application control |
| Client retries after timeout or double-click | Required idempotency key is unique per actor and stored transactionally with the response; matching retries replay the saved result | Keys are retained indefinitely in this demo; no retention/cleanup policy |
| Same idempotency key is reused for different money instructions | Request hash mismatch returns 409 and does not change balances | Keys are scoped to actor, so another actor can use the same string independently |
| Holder attempts to withdraw or transfer from another account | Authorization is checked on the server while source account is locked; unauthorized attempt is recorded as `REFUSED` | Admin intentionally has organization-wide movement privileges |
| Holder attempts to credit someone else's account | The movement transaction checks that a holder owns the account; holder demo deposits are restricted to their own account | Demo deposits intentionally simulate external funding and are not linked to a real payment provider |
| Auditor attempts to move money | Movement operation rejects the role and records a refusal when the source account exists | A compromised administrator can still move funds |
| Ledger row is edited/deleted through the application or ordinary SQL | Ledger has no update/delete endpoint; MySQL triggers reject updates/deletes | A database owner can drop triggers or alter the database files; this demo does not use a separately restricted database account |
| Negative, fractional, or malformed amount | API accepts only positive safe integer cents; schema has positive amount and non-negative balance checks | No multi-currency precision rules are implemented |
| Destination account is missing or the same as source | Both transfer account IDs are validated under transaction; invalid request is refused without posting money | Public recipient directory exposes account names and routing IDs |
| Stolen JWT | HTTPS is required in deployment, token expires in 8 hours, login attempts are rate-limited | Local development is HTTP; no refresh/revocation mechanism |
| Database outage or transaction error | Transaction is rolled back; API returns an error instead of success-shaped data | Operational alerts, backup restore, and disaster recovery are not implemented |

## Deliberately accepted risks / not built

This is a single-currency local demo. It does not implement holds, scheduled/batch payments, external payment processors, overdrafts, reversals, MFA, approval workflows, deployed hosting, or tamper-evident cryptographic chaining. Ledger rows are protected from ordinary SQL updates/deletes by triggers but not from a privileged database administrator. Production use would require a dedicated database account with restricted grants, TLS, secret management, backups, monitoring/reconciliation, and independent audit storage.
