import dotenv from 'dotenv'
import path from 'path'

dotenv.config()

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
  port: parseInt(process.env.PORT || '3001', 10),
  dbPath: process.env.DB_PATH || './data/virtual-launch.db',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '6000', 10),
  confirmations: parseInt(process.env.CONFIRMATIONS || '10', 10),

  // Indexer tuning
  initialScanWindow: 20_000,
  maxScanWindow: 1_000_000,
  transferBatchSize: 2_000,
  marketCandidateTopK: 50,

  // Market discovery scoring weights
  scoringWeights: {
    tokenTransferTouches: 1,
    virtualTransferTouches: 2,
    distinctTxCount: 3,
  },

  // Whale detection thresholds (in VIRTUAL wei as string)
  whaleThresholdSingleTrade: BigInt('1000000000000000000000'), // 1000 VIRTUAL
  whaleThresholdRollingWindow: BigInt('5000000000000000000000'), // 5000 VIRTUAL
  whaleRollingWindowMs: 60_000, // 1 minute

  // Graduation polling interval
  graduationPollMs: 30_000,

  // Whale filtering: address-level portfolio wealth threshold in USD
  whaleWealthThresholdUsd: parseFloat(
    process.env.WHALE_WEALTH_THRESHOLD_USD || '5000',
  ),

  // OKX Wallet API credentials (optional; if missing, wealth gating degrades gracefully)
  okxAccessKey: process.env.OKX_ACCESS_KEY || '',
  okxAccessSignSecret: process.env.OKX_ACCESS_SIGN_SECRET || '',
  okxAccessPassphrase: process.env.OKX_ACCESS_PASSPHRASE || '',
  okxProjectId: process.env.OKX_PROJECT_ID || '',

  // Global buyback executor address used to track buyback spending
  buybackExecutorAddress:
    (process.env.BUYBACK_EXECUTOR_ADDRESS || '0x32487287c65f11d53bbca89c2472171eb09bf337').toLowerCase(),

  // Probability model controls
  probabilityModelWindowHours: parseInt(
    process.env.PROBABILITY_MODEL_WINDOW_HOURS || '24',
    10,
  ),
  probabilityModelMinSamples: parseInt(
    process.env.PROBABILITY_MODEL_MIN_SAMPLES || '80',
    10,
  ),
  probabilityModelDefaultTargetsUsd: (process.env.PROBABILITY_MODEL_TARGETS_USD || '1000000,5000000,10000000')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0),
} as const

