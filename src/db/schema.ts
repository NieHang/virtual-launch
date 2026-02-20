import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenAddress: text('token_address').notNull(),
  virtualAddress: text('virtual_address').notNull(),
  taxRecipient: text('tax_recipient'),
  totalSupply: text('total_supply'),
  buyTaxBps: integer('buy_tax_bps'),
  phase: text('phase', { enum: ['INTERNAL', 'EXTERNAL'] })
    .notNull()
    .default('INTERNAL'),
  graduatedAt: integer('graduated_at'),
  firstActiveBlock: integer('first_active_block'),
  lastIndexedBlock: integer('last_indexed_block'),
  lastSpotPrice: real('last_spot_price'),
  createdAt: integer('created_at').notNull(),
})

export const markets = sqliteTable('markets', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  venue: text('venue', { enum: ['INTERNAL', 'EXTERNAL'] }).notNull(),
  marketAddress: text('market_address').notNull(),
  quoteToken: text('quote_token').notNull(),
  token0: text('token0'),
  token1: text('token1'),
  startBlock: integer('start_block').notNull(),
  endBlock: integer('end_block'),
  startTs: integer('start_ts'),
  endTs: integer('end_ts'),
})

export const trades = sqliteTable(
  'trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    venue: text('venue', { enum: ['INTERNAL', 'EXTERNAL'] }).notNull(),
    marketAddress: text('market_address').notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    blockNumber: integer('block_number').notNull(),
    ts: integer('ts').notNull(),
    trader: text('trader').notNull(),
    side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
    quoteIn: text('quote_in'),
    quoteInGross: text('quote_in_gross'),
    quoteOut: text('quote_out'),
    tokenIn: text('token_in'),
    tokenOut: text('token_out'),
    priceQuotePerToken: real('price_quote_per_token'),
  },
  (table) => ({
    txLogIdx: uniqueIndex('trades_tx_log_idx').on(table.txHash, table.logIndex),
  }),
)

export const addressCosts = sqliteTable(
  'address_costs',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    address: text('address').notNull(),
    spentQuoteGross: text('spent_quote_gross').notNull().default('0'), // NET spend (after tax)
    spentQuoteGrossActual: text('spent_quote_gross_actual')
      .notNull()
      .default('0'), // GROSS spend (user's actual outlay)
    tokensReceived: text('tokens_received').notNull().default('0'),
    tokensSold: text('tokens_sold').notNull().default('0'),
    quoteReceived: text('quote_received').notNull().default('0'),
    avgCost: real('avg_cost'),
    avgCostGross: real('avg_cost_gross'), // GROSS avg cost (actual user outlay per token)
    lastUpdatedBlock: integer('last_updated_block'),
  },
  (table) => ({
    projAddrIdx: uniqueIndex('address_costs_proj_addr_idx').on(
      table.projectId,
      table.address,
    ),
  }),
)

export const taxInflows = sqliteTable(
  'tax_inflows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    txHash: text('tx_hash').notNull(),
    blockNumber: integer('block_number').notNull(),
    ts: integer('ts').notNull(),
    token: text('token').notNull(),
    amount: text('amount').notNull(),
    logIndex: integer('log_index').notNull(),
  },
  (table) => ({
    txLogIdx: uniqueIndex('tax_inflows_tx_log_idx').on(
      table.txHash,
      table.logIndex,
    ),
  }),
)

export const tokenBalances = sqliteTable(
  'token_balances',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    address: text('address').notNull(),
    balance: text('balance').notNull().default('0'),
    lastUpdatedBlock: integer('last_updated_block'),
  },
  (table) => ({
    projAddrIdx: uniqueIndex('token_balances_proj_addr_idx').on(
      table.projectId,
      table.address,
    ),
  }),
)

export const indexerState = sqliteTable('indexer_state', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id),
  lastProcessedBlock: integer('last_processed_block').notNull(),
  lastProcessedTs: integer('last_processed_ts'),
  transferLogFailureCount: integer('transfer_log_failure_count'),
  lastTransferLogFailureAt: integer('last_transfer_log_failure_at'),
  lastTransferLogFailureContract: text('last_transfer_log_failure_contract'),
  lastTransferLogFailureFromBlock: text('last_transfer_log_failure_from_block'),
  lastTransferLogFailureToBlock: text('last_transfer_log_failure_to_block'),
  lastTransferLogFailureError: text('last_transfer_log_failure_error'),
})

