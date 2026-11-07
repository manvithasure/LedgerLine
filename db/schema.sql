CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('ADMIN', 'HOLDER', 'AUDITOR') NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS accounts (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  owner_user_id CHAR(36) NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_accounts_nonnegative CHECK (balance_cents >= 0),
  CONSTRAINT fk_accounts_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_requests (
  actor_user_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status ENUM('PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL,
  http_status SMALLINT NULL,
  response_json JSON NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (actor_user_id, idempotency_key),
  CONSTRAINT fk_idempotency_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS transfers (
  id CHAR(36) PRIMARY KEY,
  actor_user_id CHAR(36) NOT NULL,
  source_account_id CHAR(36) NOT NULL,
  destination_account_id CHAR(36) NULL,
  movement ENUM('DEPOSIT', 'WITHDRAWAL', 'TRANSFER') NOT NULL,
  amount_cents BIGINT NOT NULL,
  description VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_transfers_positive CHECK (amount_cents > 0),
  CONSTRAINT fk_transfers_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_transfers_source FOREIGN KEY (source_account_id) REFERENCES accounts(id),
  CONSTRAINT fk_transfers_destination FOREIGN KEY (destination_account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transfer_id CHAR(36) NULL,
  account_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NOT NULL,
  entry_type ENUM('DEBIT', 'CREDIT', 'REFUSED') NOT NULL,
  amount_cents BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  description VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX idx_ledger_account_time (account_id, created_at, id),
  INDEX idx_ledger_transfer (transfer_id),
  CONSTRAINT chk_ledger_amount CHECK (amount_cents > 0),
  CONSTRAINT chk_ledger_balance CHECK (balance_after_cents >= 0),
  CONSTRAINT fk_ledger_transfer FOREIGN KEY (transfer_id) REFERENCES transfers(id),
  CONSTRAINT fk_ledger_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_ledger_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
