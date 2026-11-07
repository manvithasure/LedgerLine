-- Run this in the TiDB Cloud SQL editor as the cluster admin.
-- Replace `ledgerline` with the database name shown by TiDB Cloud.
-- Replace `YOUR_CLUSTER_PREFIX.ledgerline_app` with a username that includes
-- the TiDB cluster's required username prefix. Use a unique password locally;
-- do not commit a filled-in copy of this file.

CREATE USER 'YOUR_CLUSTER_PREFIX.ledgerline_app'@'%'
  IDENTIFIED BY 'REPLACE_WITH_A_RANDOM_PASSWORD';

GRANT SELECT, INSERT ON `ledgerline`.users
  TO 'YOUR_CLUSTER_PREFIX.ledgerline_app'@'%';
GRANT SELECT, INSERT, UPDATE ON `ledgerline`.accounts
  TO 'YOUR_CLUSTER_PREFIX.ledgerline_app'@'%';
GRANT SELECT, INSERT, UPDATE ON `ledgerline`.idempotency_requests
  TO 'YOUR_CLUSTER_PREFIX.ledgerline_app'@'%';
GRANT SELECT, INSERT ON `ledgerline`.transfers
  TO 'YOUR_CLUSTER_PREFIX.ledgerline_app'@'%';
GRANT SELECT, INSERT ON `ledgerline`.ledger_entries
  TO 'YOUR_CLUSTER_PREFIX.ledgerline_app'@'%';
