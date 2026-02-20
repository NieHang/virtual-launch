import { sqlite } from './index.js'

/**
 * Push schema directly using raw SQL (no drizzle-kit needed at runtime).
 * This creates all tables if they don't exist.
 */
export function pushSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_address TEXT NOT NULL,
      virtual_address TEXT NOT NULL,
      tax_recipient TEXT,
      total_supply TEXT,
      buy_tax_bps INTEGER,
      phase TEXT NOT NULL DEFAULT 'INTERNAL',
      graduated_at INTEGER,
      first_active_block INTEGER,
      last_indexed_block INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      venue TEXT NOT NULL,
      market_address TEXT NOT NULL,
      quote_token TEXT NOT NULL,
      token0 TEXT,
      token1 TEXT,
      start_block INTEGER NOT NULL,
      end_block INTEGER,
      start_ts INTEGER,
      end_ts INTEGER
    );

  

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      venue TEXT NOT NULL,
      market_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      trader TEXT NOT NULL,
      side TEXT NOT NULL,
      quote_in TEXT,
      quote_out TEXT,
      token_in TEXT,
      token_out TEXT,
      price_quote_per_token REAL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS trades_tx_log_idx ON trades(tx_hash, log_index);
    CREATE INDEX IF NOT EXISTS trades_project_block_idx ON trades(project_id, block_number);
    CREATE INDEX IF NOT EXISTS trades_project_trader_idx ON trades(project_id, trader);

    CREATE TABLE IF NOT EXISTS address_costs (
      project_id TEXT NOT NULL REFERENCES projects(id),
      address TEXT NOT NULL,
      spent_quote_gross TEXT NOT NULL DEFAULT '0',
      tokens_received TEXT NOT NULL DEFAULT '0',
      tokens_sold TEXT NOT NULL DEFAULT '0',
      quote_received TEXT NOT NULL DEFAULT '0',
      avg_cost REAL,
      last_updated_block INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS address_costs_proj_addr_idx ON address_costs(project_id, address);

    CREATE TABLE IF NOT EXISTS tax_inflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      log_index INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tax_inflows_tx_log_idx ON tax_inflows(tx_hash, log_index);
    CREATE INDEX IF NOT EXISTS tax_inflows_project_idx ON tax_inflows(project_id);

    CREATE TABLE IF NOT EXISTS indexer_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      last_processed_block INTEGER NOT NULL,
      last_processed_ts INTEGER,
      transfer_log_failure_count INTEGER,
      last_transfer_log_failure_at INTEGER,
      last_transfer_log_failure_contract TEXT,
      last_transfer_log_failure_from_block TEXT,
      last_transfer_log_failure_to_block TEXT,
      last_transfer_log_failure_error TEXT
    );
  `)

  // Token balances table (tracks real holdings from all Transfer events)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS token_balances (
      project_id TEXT NOT NULL REFERENCES projects(id),
      address TEXT NOT NULL,
      balance TEXT NOT NULL DEFAULT '0',
      last_updated_block INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS token_balances_proj_addr_idx ON token_balances(project_id, address);
    CREATE INDEX IF NOT EXISTS token_balances_proj_balance_idx ON token_balances(project_id, balance);
  `)

  // Safe migrations for existing DBs
  try { sqlite.exec(`ALTER TABLE markets ADD COLUMN token0 TEXT`) } catch {}
  try { sqlite.exec(`ALTER TABLE markets ADD COLUMN token1 TEXT`) } catch {}
  try { sqlite.exec(`ALTER TABLE projects ADD COLUMN last_spot_price REAL`) } catch {}
  try { sqlite.exec(`ALTER TABLE trades ADD COLUMN quote_in_gross TEXT`) } catch {}
  try { sqlite.exec(`ALTER TABLE address_costs ADD COLUMN spent_quote_gross_actual TEXT NOT NULL DEFAULT '0'`) } catch {}
  try { sqlite.exec(`ALTER TABLE address_costs ADD COLUMN avg_cost_gross REAL`) } catch {}
  try { sqlite.exec(`ALTER TABLE address_costs ADD COLUMN avg_cost_gross REAL`) } catch {}
  try { sqlite.exec(`ALTER TABLE indexer_state ADD COLUMN transfer_log_failure_count INTEGER`) } catch {}
  try { sqlite.exec(`ALTER TABLE indexer_state ADD COLUMN last_transfer_log_failure_at INTEGER`) } catch {}
  try { sqlite.exec(`ALTER TABLE indexer_state ADD COLUMN last_transfer_log_failure_contract TEXT`) } catch {}
  try { sqlite.exec(`ALTER TABLE indexer_state ADD COLUMN last_transfer_log_failure_from_block TEXT`) } catch {}
  try { sqlite.exec(`ALTER TABLE indexer_state ADD COLUMN last_transfer_log_failure_to_block TEXT`) } catch {}
  try { sqlite.exec(`ALTER TABLE indexer_state ADD COLUMN last_transfer_log_failure_error TEXT`) } catch {}

  console.log('[DB] Schema pushed successfully')
}

