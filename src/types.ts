// ---- Enums ----
export type Venue = 'INTERNAL' | 'EXTERNAL'
export type Phase = 'INTERNAL' | 'EXTERNAL'
export type Side = 'BUY' | 'SELL'

// ---- Domain Types ----
export interface Project {
  id: string
  name: string
  tokenAddress: string
  virtualAddress: string
  taxRecipient: string | null
  totalSupply: string | null
  buyTaxBps: number | null
  phase: Phase
  graduatedAt: number | null
  firstActiveBlock: number | null
  lastIndexedBlock: number | null
  createdAt: number
}

export interface Market {
  id: string
  projectId: string
  venue: Venue
  marketAddress: string
  quoteToken: string
  startBlock: number
  endBlock: number | null
  startTs: number | null
  endTs: number | null
}

export interface Trade {
  id?: number
  projectId: string
  venue: Venue
  marketAddress: string
  txHash: string
  logIndex: number
  blockNumber: number
  ts: number
  trader: string
  side: Side
  quoteIn: string | null // NET VIRTUAL into market (after tax deduction)
  quoteInGross: string | null // GROSS VIRTUAL user actually paid (before tax)
  quoteOut: string | null
  tokenIn: string | null
  tokenOut: string | null
  priceQuotePerToken: number | null
}

export interface AddressCost {
  projectId: string
  address: string
  spentQuoteGross: string
  tokensReceived: string
  tokensSold: string
  quoteReceived: string
  avgCost: number | null
  lastUpdatedBlock: number | null
}

export interface TaxInflow {
  id?: number
  projectId: string
  txHash: string
  blockNumber: number
  ts: number
  token: string
  amount: string
  logIndex: number
}

// ---- API Response Types ----
export interface ProjectState {
  project: Project
  markets: Market[]
  spotPrice: number | null
  spotPriceUsd: number | null
  fdv: number | null
  fdvUsd: number | null
  efdv: number | null
  efdvUsd: number | null
  buyTaxRate: number | null
  graduationProgress: number | null
  internalMarketAddress: string | null
  internalVirtualBalance: string | null
  totalTaxCollectedVirtual: string
  totalTaxCollectedToken: string
  graduationTaxVirtual: string | null
  buybackSpentVirtual: string | null
  remainingTaxVirtual: string | null
  virtualUsdPrice: number | null
  taxModelStartTs?: number | null
}

export interface WhaleEntry {
  address: string
  balance: string // actual on-chain token balance (from Transfer events)
  hasTrades?: boolean
  dataCompleteness?: 'TRADES_BASED' | 'TRANSFER_ONLY'
  spentQuoteGross: string // GROSS VIRTUAL user actually paid (before tax)
  spentQuoteNet: string // NET VIRTUAL that reached the market (after tax)
  taxPaid: string // tax portion = gross - net
  tokensReceived: string // total tokens bought via trades
  tokensSold: string // total tokens sold via trades
  remainingTokens: string // tokensReceived - tokensSold (floored at 0)
  remainingCostNet: string // remaining NET cost basis under average-cost method
  remainingCostGross: string // remaining GROSS cost basis under average-cost method
  quoteReceived: string // total VIRTUAL received from selling
  avgCost: number | null // NET avg cost (market execution price)
  avgCostGross: number | null // GROSS avg cost (user's real cost including tax)
  avgCostOpen: number | null // NET avg cost of remaining position
  avgCostOpenGross: number | null // GROSS avg cost of remaining position
  realizedPnl: number | null // quoteReceived - cost basis of sold tokens (based on gross)
}

export interface InternalWhaleProfile {
  address: string
  balance: string
  holdingShare: number
  buyVolumeGross: string
  externalBuyGross: string
  allVenueBuyGross: string
  buyVolumeNet: string
  buyVolumeToken: string
  avgBuyTaxRate: number | null
  avgBuyTaxRateSource: 'INTERNAL_ONLY' | 'ALL_BUYS'
  avgCostGross: number | null
  avgCostNet: number | null
  realizedPnl: number | null
  unrealizedPnl: number | null
  remainingTokens: string
  totalValueUsd?: number | null
  wealthUnknown?: boolean
  debugReason?: string
}

export interface WhaleActivityEntry {
  txHash: string
  blockNumber: number
  ts: number
  venue: Venue
  address: string
  side: Side
  action: 'ADD' | 'REDUCE'
  quoteGross: string
  quoteNet: string
  tokenAmount: string
  taxRate: number | null
  taxRateSource?: 'INTERNAL_ONLY' | 'ALL_BUYS'
  baselineAvgCostGross: number | null
  realizedPnlEstimate: number | null
  totalValueUsd?: number | null
  wealthUnknown?: boolean
  debugReason?: string
}

export interface WhalePressureSummary {
  topN: number
  totalHeld: string
  totalSupply: string
  heldShare: number
}

export interface WhalePressureTier {
  sellShareOfHeld: number
  sellAmountToken: string
  avgCostGross: number | null
  estimatedNotionalV: number | null
}

export interface WhalePressureResponse {
  summaries: WhalePressureSummary[]
  tiers: WhalePressureTier[]
  topWhales: Array<{ address: string; balance: string; shareOfSupply: number }>
}

export interface DumpSimulationResult {
  reserveVirtual: string
  reserveToken: string
  sellAmountToken: string
  virtualOut: string
  initialPrice: number
  finalPrice: number
  priceImpactPercent: number
  requiredBuybackVirtual: string
}

export interface WhaleAbsorptionResponse {
  remainingTaxVirtual: string
  requiredBuybackVirtual: string
  canAbsorb: boolean
  coverageRatio: number | null
  simulation: DumpSimulationResult
}

export interface LargeOrder {
  txHash: string
  blockNumber: number
  ts: number
  trader: string
  venue: Venue
  quoteInGross: string // user's actual VIRTUAL outlay
  quoteInNet: string // VIRTUAL that reached market
  taxPaid: string
  taxRate: number // e.g. 0.99 = 99%
  tokenOut: string | null
  priceNet: number | null // market execution price
  priceGross: number | null // user's actual price per token (including tax)
}

export interface CostSummary {
  weightedAvgCost: number | null
  equalWeightAvgCost: number | null
  p50: number | null
  p75: number | null
  p90: number | null
  addressCount: number
}

export interface TaxSummary {
  actualVirtual: string
  actualToken: string
  estimatedVirtual: string
  estimatedToken: string
}

export interface EfdvLayerRow {
  taxRate: number
  impliedFdv: number
  impliedEfdv: number
  breakevenMultiple: number
}

export interface EfdvLayerResponse {
  projectId: string
  mode: 'prelaunch' | 'live'
  basePrice: number
  priceSource: 'LAUNCH_CURVE_DERIVED' | 'LIVE_SPOT'
  taxModel: 'LINEAR_99_TO_1'
  totalSupply: string
  layers: EfdvLayerRow[]
}

export interface ThresholdProbabilityResponse {
  projectId: string
  targetMarketCapUsd: number
  horizonHours: number
  probability: number
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  modelVersion: string
  trainedAt: string
  currentMarketCapUsd: number | null
  factors: Array<{ name: string; value: number; contribution: number }>
  featureSnapshot: {
    remainingBuybackUsd: number
    buyTaxRate: number
    concentrationTop10: number
    buyMomentum: number
    sampleTrades: number
  }
}

export interface BuybackSimulation {
  budget: string // total tax budget used for simulation
  amountPerStep: string // buyback amount per interval
  remainderAmount: string // last partial buy amount (if any)
  steps: number
  stepIntervalSeconds: number
  totalTokensBought: string
  avgPrice: number
  maxSlippage: number
  initialPrice: number
  priceTrajectory: Array<{
    step: number
    price: number
    tokensBought: string
    elapsed: string
  }>
  finalPrice: number
  priceImpactPercent: number
  reserveVirtual: string
  reserveToken: string
  assumptions: {
    noExternalSells: boolean
    useCurrentLpReserves: boolean
    mode: 'IDEAL' | 'REALISTIC'
    sellPressureBpsPerStep: number
    priceAnchor: 'RESERVE' | 'SPOT'
    spotPriceAnchor: number | null
  }
}

// ---- WebSocket Event Types ----
export interface WsTrade {
  type: 'trade'
  projectId: string
  trade: Trade
}

export interface WsWhaleAlert {
  type: 'whale_alert'
  projectId: string
  address: string
  quoteIn: string
  side: Side
}

export interface WsStateUpdate {
  type: 'state'
  projectId: string
  spotPrice: number | null
  fdv: number | null
  phase: Phase
}

export type WsEvent = WsTrade | WsWhaleAlert | WsStateUpdate

// ---- Parsed Log Types ----
export interface ParsedTransfer {
  address: string // contract that emitted the event
  from: string
  to: string
  value: bigint
  txHash: string
  logIndex: number
  blockNumber: number
}

