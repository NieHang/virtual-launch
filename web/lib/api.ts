const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api'

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(error.error || `HTTP ${res.status}`)
  }

  return res.json()
}

export interface Project {
  id: string
  name: string
  tokenAddress: string
  phase: 'INTERNAL' | 'EXTERNAL'
  createdAt: number
}

export interface ProjectState {
  project: Project
  markets: Array<{ venue: string; marketAddress: string }>
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

export interface Trade {
  id: number
  venue: string
  txHash: string
  blockNumber: number
  ts: number
  trader: string
  side: 'BUY' | 'SELL'
  quoteIn: string | null
  quoteInGross?: string | null
  quoteOut: string | null
  tokenIn: string | null
  tokenOut: string | null
  priceQuotePerToken: number | null
}

export interface AddressDetail {
  projectId: string
  address: string
  balance: string
  cost: {
    spentQuoteGross: string
    spentQuoteNet: string
    taxPaid: string
    tokensReceived: string
    tokensSold: string
    quoteReceived: string
    remainingTokens: string
    remainingCostGross: string
    remainingCostNet: string
    avgCost: number | null
    avgCostGross: number | null
    avgCostOpen: number | null
    avgCostOpenGross: number | null
    realizedPnl: number | null
    unrealizedPnl: number | null
    markPrice: number | null
  }
  recentTrades: Trade[]
}

export interface WhaleEntry {
  address: string
  balance: string
  hasTrades?: boolean
  dataCompleteness?: 'TRADES_BASED' | 'TRANSFER_ONLY'
  spentQuoteGross: string
  spentQuoteNet: string
  taxPaid: string
  tokensReceived: string
  tokensSold: string
  remainingTokens: string
  remainingCostNet: string
  remainingCostGross: string
  quoteReceived: string
  avgCost: number | null
  avgCostGross: number | null
  avgCostOpen: number | null
  avgCostOpenGross: number | null
  realizedPnl: number | null
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
  venue: 'INTERNAL' | 'EXTERNAL'
  address: string
  side: 'BUY' | 'SELL'
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
  venue: string
  quoteInGross: string
  quoteInNet: string
  taxPaid: string
  taxRate: number
  tokenOut: string | null
  priceNet: number | null
  priceGross: number | null
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
  prebuyRatio: number
  prebuyMultiplier: number
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
  budget: string
  amountPerStep: string
  remainderAmount: string
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
    priceAnchor?: 'RESERVE' | 'SPOT'
    spotPriceAnchor?: number | null
  }
}

export const api = {
  getProjects: () => fetchApi<Project[]>('/projects'),

  addProject: (tokenAddress: string, name?: string) =>
    fetchApi<{ id: string; name: string; tokenAddress: string }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ tokenAddress, name }),
    }),

  getProjectState: (id: string) =>
    fetchApi<ProjectState>(`/projects/${id}/state`),

  getWhales: (
    id: string,
    limit = 20,
    includeTransferOnly = false,
    onlyEoa = true,
  ) =>
    fetchApi<WhaleEntry[]>(
      `/projects/${id}/whales?limit=${limit}&includeTransferOnly=${includeTransferOnly ? '1' : '0'}&onlyEoa=${onlyEoa ? '1' : '0'}`,
    ),

  getInternalWhales: (id: string, limit = 20, onlyEoa = true) =>
    fetchApi<{
      totalSupply: string
      count: number
      items: InternalWhaleProfile[]
    }>(
      `/projects/${id}/whales/internal?limit=${limit}&onlyEoa=${onlyEoa ? '1' : '0'}`,
    ),

  getWhaleActivity: (
    id: string,
    limit = 50,
    offset = 0,
    thresholdWei?: string,
    onlyEoa = true,
    includeClosed = false,
  ) => {
    let url = `/projects/${id}/whales/activity?limit=${limit}&offset=${offset}&onlyEoa=${onlyEoa ? '1' : '0'}&includeClosed=${includeClosed ? '1' : '0'}`
    if (thresholdWei) url += `&threshold=${thresholdWei}`
    return fetchApi<{
      limit: number
      offset: number
      total: number
      threshold: string
      items: WhaleActivityEntry[]
    }>(url)
  },

  getWhaleActivityByAddress: (
    id: string,
    address: string,
    limit = 50,
    offset = 0,
    thresholdWei?: string,
    onlyEoa = true,
    includeClosed = false,
  ) => {
    let url = `/projects/${id}/whales/activity/${address}?limit=${limit}&offset=${offset}&onlyEoa=${onlyEoa ? '1' : '0'}&includeClosed=${includeClosed ? '1' : '0'}`
    if (thresholdWei) url += `&threshold=${thresholdWei}`
    return fetchApi<{
      limit: number
      offset: number
      total: number
      threshold: string
      items: WhaleActivityEntry[]
    }>(url)
  },

  getWhalePressure: (id: string, onlyEoa = true) =>
    fetchApi<WhalePressureResponse>(
      `/projects/${id}/whales/pressure?onlyEoa=${onlyEoa ? '1' : '0'}`,
    ),

  simulateDump: (
    id: string,
    params: {
      sellAmount?: string
      sellShare?: number
      topN?: number
      mode?: 'IDEAL' | 'CONSERVATIVE'
    },
  ) =>
    fetchApi<{
      mode: 'IDEAL' | 'CONSERVATIVE'
      simulation: DumpSimulationResult
    }>(`/projects/${id}/simulate-dump`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  getWhaleAbsorption: (
    id: string,
    params?: {
      sellShare?: number
      topN?: number
      mode?: 'IDEAL' | 'CONSERVATIVE'
      onlyEoa?: boolean
    },
  ) => {
    const q = new URLSearchParams()
    if (params?.sellShare !== undefined)
      q.set('sellShare', String(params.sellShare))
    if (params?.topN !== undefined) q.set('topN', String(params.topN))
    if (params?.mode) q.set('mode', params.mode)
    q.set('onlyEoa', params?.onlyEoa === false ? '0' : '1')
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return fetchApi<WhaleAbsorptionResponse>(
      `/projects/${id}/whales/absorption${suffix}`,
    )
  },

  getAddressDetail: (id: string, address: string, limit = 30) =>
    fetchApi<AddressDetail>(
      `/projects/${id}/addresses/${address}?limit=${limit}`,
    ),

  getCostSummary: (id: string) =>
    fetchApi<CostSummary>(`/projects/${id}/costs/summary`),

  getTaxSummary: (id: string) =>
    fetchApi<TaxSummary>(`/projects/${id}/tax/summary`),

  getEfdvLayers: (
    id: string,
    mode: 'prelaunch' | 'live' = 'prelaunch',
    prebuyRatio = 0,
    baseFdvVirtual?: number,
  ) => {
    const q = new URLSearchParams()
    q.set('mode', mode)
    q.set('prebuyRatio', String(prebuyRatio))
    if (baseFdvVirtual !== undefined) {
      q.set('baseFdvVirtual', String(baseFdvVirtual))
    }
    return fetchApi<EfdvLayerResponse>(`/projects/${id}/efdv/layers?${q.toString()}`)
  },

  getMarketCapThresholdProbability: (
    id: string,
    targetMarketCapUsd: number,
    horizonHours = 24,
  ) =>
    fetchApi<ThresholdProbabilityResponse>(
      `/projects/${id}/probability/marketcap-threshold?target=${targetMarketCapUsd}&horizon=${horizonHours}`,
    ),

  getTrades: (id: string, limit = 200, venue?: string) => {
    let url = `/projects/${id}/trades?limit=${limit}`
    if (venue) url += `&venue=${venue}`
    return fetchApi<{ trades: Trade[]; total: number }>(`${url}`)
  },

  getLargeOrders: (id: string, thresholdVirtual = 100, limit = 50) => {
    const thresholdWei =
      BigInt(Math.floor(thresholdVirtual)) * BigInt('1000000000000000000')
    return fetchApi<{ threshold: string; count: number; orders: LargeOrder[] }>(
      `/projects/${id}/large-orders?threshold=${thresholdWei.toString()}&limit=${limit}`,
    )
  },

  simulateBuyback: (
    id: string,
    params: {
      amountPerStep: string
      intervalSeconds: number
      totalTaxInput: string
      realisticMode?: boolean
      anchorToSpotPrice?: boolean
    },
  ) =>
    fetchApi<BuybackSimulation>(`/projects/${id}/simulate-buyback`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),
}

