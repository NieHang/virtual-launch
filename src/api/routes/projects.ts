import type { FastifyInstance } from 'fastify'
import { type Address, getAddress } from 'viem'
import { db, schema } from '../../db/index.js'
import { eq, and, desc, asc, sql } from 'drizzle-orm'
import { VIRTUAL_ADDRESS } from '../../chain/constants.js'
import { computeCostSummary } from '../../metrics/average-cost.js'
import {
  computeTaxSummary,
  computeBuybackTaxProgress,
} from '../../metrics/tax.js'
import {
  computeFdvEfdv,
  computeLayeredEfdv,
  deriveLaunchCurveBasePrice,
  getCurrentBuyTaxRate,
  readTotalSupply,
} from '../../metrics/efdv.js'
import { getDecayTaxRate } from '../../indexer/tax-tracker.js'
import { getExternalSpotPrice } from '../../indexer/external-parser.js'
import { getClient } from '../../chain/client.js'
import { TOKEN_ABI } from '../../chain/constants.js'
import { initializeProject, runIndexerLoop } from '../../indexer/index.js'
import type { ProjectState, WhaleEntry } from '../../types.js'
import { cacheGet, cacheSet } from '../cache.js'
import { getPriceState, getVirtualUsdPrice } from '../../indexer/price-cache.js'
import { proxyFetch } from '../../chain/proxy.js'
import { getTransferLogFailureStat } from '../../indexer/observability.js'
import { simulateDump } from '../../metrics/buyback-sim.js'
import { computeThresholdProbability } from '../../metrics/threshold-probability.js'
import { isContract } from '../../chain/utils.js'
import { config } from '../../config.js'
import { createHmac } from 'node:crypto'

interface GeckoPoolSnapshot {
  priceUsd: number | null
  fdvUsd: number | null
}

const KNOWN_EXCLUDED_ADDRESS_REASONS: Array<{
  address: string
  reason: string
}> = [
  {
    address: '0x0000000000000000000000000000000000000000',
    reason: 'zero address',
  },
  {
    address: '0x000000000000000000000000000000000000dead',
    reason: 'dead address',
  },
  {
    address: '0x111111125421ca6dc452d289314280a0f8842a65',
    reason: '1inch v6 router',
  },
  {
    address: '0x1111111254eeb25477b68fb85ed929f73a960582',
    reason: '1inch v5 router',
  },
  {
    address: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
    reason: 'Uniswap V2 router',
  },
  {
    address: '0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891',
    reason: 'Aerodrome router',
  },
  {
    address: '0x07c3c91a0db71af66b2aed70d4d59a2f7c3c0531',
    reason: 'Universal router',
  },
  {
    address: '0x32487287c65f11d53bbca89c2472171eb09bf337',
    reason: 'buyback tax address',
  },
]
const GLOBAL_EXCLUDED_WHALE_ADDRESSES: Array<{
  address: string
  reason: string
}> = [
  {
    address: '0x32487287c65f11d53bbca89c2472171eb09bf337',
    reason: 'global buyback address',
  },
]

function parseBoolParam(
  raw: string | undefined,
  defaultValue: boolean,
): boolean {
  if (raw === undefined) return defaultValue
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return defaultValue
}

function sortByBalanceDesc<T extends { balance: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aBal = BigInt(a.balance)
    const bBal = BigInt(b.balance)
    if (bBal > aBal) return 1
    if (bBal < aBal) return -1
    return 0
  })
}

function buildExcludedAddressReasonMap(
  projectId: string,
  tokenAddress: string,
): Map<string, string> {
  const reasons = new Map<string, string>()
  for (const item of KNOWN_EXCLUDED_ADDRESS_REASONS) {
    reasons.set(item.address, item.reason)
  }
  for (const item of GLOBAL_EXCLUDED_WHALE_ADDRESSES) {
    reasons.set(item.address, item.reason)
  }

  reasons.set(tokenAddress.toLowerCase(), 'token contract')

  const externalMarket = db
    .select()
    .from(schema.markets)
    .where(
      and(
        eq(schema.markets.projectId, projectId),
        eq(schema.markets.venue, 'EXTERNAL'),
      ),
    )
    .get()
  if (externalMarket) {
    reasons.set(
      externalMarket.marketAddress.toLowerCase(),
      'external market address',
    )
  }

  const internalMarket = db
    .select()
    .from(schema.markets)
    .where(
      and(
        eq(schema.markets.projectId, projectId),
        eq(schema.markets.venue, 'INTERNAL'),
      ),
    )
    .get()
  if (internalMarket) {
    reasons.set(
      internalMarket.marketAddress.toLowerCase(),
      'internal market address',
    )
  }

  return reasons
}

async function isEoaAddressWithCache(rawAddress: string): Promise<boolean> {
  try {
    const normalized = getAddress(rawAddress)
    const key = `addr:is-eoa:${normalized.toLowerCase()}`
    const cached = cacheGet<boolean>(key)
    if (typeof cached === 'boolean') return cached

    const contract = await isContract(normalized as Address).catch(() => true)
    const eoa = !contract
    cacheSet(key, eoa, 60 * 60_000)
    return eoa
  } catch {
    return false
  }
}

interface WealthGateResult {
  totalValueUsd: number | null
  wealthUnknown: boolean
  passesWealthThreshold: boolean
}

interface WhaleDecision {
  address: string
  isEoa: boolean
  totalValueUsd: number | null
  wealthUnknown: boolean
  passesWealthThreshold: boolean
  included: boolean
  reason:
    | 'OK'
    | 'EOA_FAIL'
    | 'WEALTH_BELOW_THRESHOLD'
    | 'WEALTH_UNKNOWN_FALLBACK'
}

function hasOkxWalletApiConfig(): boolean {
  return Boolean(
    config.okxAccessKey &&
    config.okxAccessSignSecret &&
    config.okxAccessPassphrase &&
    config.okxProjectId,
  )
}

function buildOkxWalletSignature(
  timestamp: string,
  method: string,
  requestPathWithQuery: string,
): string {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPathWithQuery}`
  return createHmac('sha256', config.okxAccessSignSecret)
    .update(prehash)
    .digest('base64')
}

async function getAddressTotalValueUsd(
  rawAddress: string,
): Promise<number | null> {
  const normalized = getAddress(rawAddress).toLowerCase()
  const cacheKey = `okx:wallet-total-usd:${normalized}`
  const cached = cacheGet<number | null>(cacheKey)
  if (cached !== undefined) return cached

  if (!hasOkxWalletApiConfig()) {
    cacheSet(cacheKey, null, 60_000)
    return null
  }

  const openCircuitKey = 'okx:wallet-total-usd:circuit-open'
  const circuitOpen = cacheGet<boolean>(openCircuitKey)
  if (circuitOpen) return null

  const requestPath = `/api/v6/dex/balance/total-value-by-address?address=${normalized}&chains=8453&assetType=0&excludeRiskToken=true`
  const timestamp = new Date().toISOString()
  const signature = buildOkxWalletSignature(timestamp, 'GET', requestPath)

  try {
    const res = await proxyFetch(`https://web3.okx.com${requestPath}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'OK-ACCESS-KEY': config.okxAccessKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-PASSPHRASE': config.okxAccessPassphrase,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PROJECT': config.okxProjectId,
      },
    })
    if (!res.ok) {
      cacheSet(openCircuitKey, true, 30_000)
      cacheSet(cacheKey, null, 30_000)
      return null
    }
    const body = (await res.json()) as any
    const totalRaw = body?.data?.[0]?.totalValue
    const total = Number(totalRaw)
    const value = Number.isFinite(total) && total >= 0 ? total : null
    cacheSet(cacheKey, value, 10 * 60_000)
    return value
  } catch {
    cacheSet(openCircuitKey, true, 30_000)
    cacheSet(cacheKey, null, 30_000)
    return null
  }
}

async function evaluateWealthGate(
  rawAddress: string,
): Promise<WealthGateResult> {
  const totalValueUsd = await getAddressTotalValueUsd(rawAddress)
  if (totalValueUsd === null) {
    return {
      totalValueUsd: null,
      wealthUnknown: true,
      passesWealthThreshold: true,
    }
  }
  return {
    totalValueUsd,
    wealthUnknown: false,
    passesWealthThreshold: totalValueUsd >= config.whaleWealthThresholdUsd,
  }
}

async function evaluateWhaleDecision(
  rawAddress: string,
  onlyEoa: boolean,
): Promise<WhaleDecision> {
  const normalized = getAddress(rawAddress).toLowerCase()
  const isEoa = await isEoaAddressWithCache(normalized)
  if (onlyEoa && !isEoa) {
    return {
      address: normalized,
      isEoa,
      totalValueUsd: null,
      wealthUnknown: false,
      passesWealthThreshold: false,
      included: false,
      reason: 'EOA_FAIL',
    }
  }

  const wealth = await evaluateWealthGate(normalized)
  if (!wealth.wealthUnknown && !wealth.passesWealthThreshold) {
    return {
      address: normalized,
      isEoa,
      totalValueUsd: wealth.totalValueUsd,
      wealthUnknown: false,
      passesWealthThreshold: false,
      included: false,
      reason: 'WEALTH_BELOW_THRESHOLD',
    }
  }

  return {
    address: normalized,
    isEoa,
    totalValueUsd: wealth.totalValueUsd,
    wealthUnknown: wealth.wealthUnknown,
    passesWealthThreshold: wealth.passesWealthThreshold,
    included: true,
    reason: wealth.wealthUnknown ? 'WEALTH_UNKNOWN_FALLBACK' : 'OK',
  }
}

async function isStrictEoaAddress(rawAddress: string): Promise<boolean> {
  let normalized: Address
  try {
    normalized = getAddress(rawAddress) as Address
  } catch {
    return false
  }
  const lower = normalized.toLowerCase()
  const key = `addr:is-eoa:${lower}`
  const cached = cacheGet<boolean>(key)
  if (cached !== undefined) return cached

  try {
    const client = getClient()
    const code = await client.getCode({ address: normalized })
    const isEoa = !code || code === '0x'
    cacheSet(key, isEoa, 10 * 60_000)
    return isEoa
  } catch {
    return false
  }
}

interface ObservedTaxRateEstimate {
  rate: number | null
  sampleCount: number
}

interface WhaleCostSnapshot {
  spentNet: bigint
  spentGross: bigint
  tokensReceived: bigint
  tokensSold: bigint
  quoteReceived: bigint
  remainingTokens: bigint
  remainingCostNet: bigint
  remainingCostGross: bigint
  avgCostOpen: number | null
  avgCostOpenGross: number | null
  realizedPnl: number | null
}

function getWhaleCostSnapshot(cost: any | undefined): WhaleCostSnapshot {
  const spentNet = cost ? BigInt(cost.spentQuoteGross) : 0n
  const spentGross = cost ? BigInt(cost.spentQuoteGrossActual || '0') : 0n
  const tokensReceived = cost ? BigInt(cost.tokensReceived) : 0n
  const tokensSold = cost ? BigInt(cost.tokensSold) : 0n
  const quoteReceived = cost ? BigInt(cost.quoteReceived) : 0n
  const remainingTokens =
    tokensReceived > tokensSold ? tokensReceived - tokensSold : 0n

  const soldCostNet =
    tokensSold > 0n && tokensReceived > 0n
      ? (spentNet * tokensSold) / tokensReceived
      : 0n
  const soldCostGross =
    tokensSold > 0n && tokensReceived > 0n
      ? (spentGross * tokensSold) / tokensReceived
      : 0n
  const remainingCostNet = spentNet > soldCostNet ? spentNet - soldCostNet : 0n
  const remainingCostGross =
    spentGross > soldCostGross ? spentGross - soldCostGross : 0n

  const avgCostOpen =
    remainingTokens > 0n
      ? Number(remainingCostNet) / Number(remainingTokens)
      : null
  const avgCostOpenGross =
    remainingTokens > 0n
      ? Number(remainingCostGross) / Number(remainingTokens)
      : null

  let realizedPnl: number | null = null
  if (tokensSold > 0n && tokensReceived > 0n && spentGross > 0n) {
    const costBasis =
      (Number(tokensSold) / Number(tokensReceived)) * Number(spentGross)
    realizedPnl = (Number(quoteReceived) - costBasis) / 1e18
  }

  return {
    spentNet,
    spentGross,
    tokensReceived,
    tokensSold,
    quoteReceived,
    remainingTokens,
    remainingCostNet,
    remainingCostGross,
    avgCostOpen,
    avgCostOpenGross,
    realizedPnl,
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const clamped = Math.min(1, Math.max(0, p))
  const idx = (sorted.length - 1) * clamped
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const w = idx - lo
  return sorted[lo] * (1 - w) + sorted[hi] * w
}

function computeObservedBuyTaxRate(projectId: string): ObservedTaxRateEstimate {
  const buys = db
    .select()
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.projectId, projectId),
        eq(schema.trades.side, 'BUY'),
      ),
    )
    .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
    .limit(500)
    .all()

  if (buys.length === 0) {
    return { rate: null, sampleCount: 0 }
  }

  const points: Array<{ rate: number; gross: bigint; idx: number }> = []
  for (let i = 0; i < buys.length; i++) {
    const t = buys[i]
    const g = t.quoteInGross
      ? BigInt(t.quoteInGross)
      : t.quoteIn
        ? BigInt(t.quoteIn)
        : 0n
    const n = t.quoteIn ? BigInt(t.quoteIn) : 0n
    if (g <= 0n || n < 0n || n > g) continue

    const rate = Number(g - n) / Number(g)
    if (!Number.isFinite(rate) || rate < 0 || rate > 0.9999) continue
    points.push({ rate, gross: g, idx: i })
  }

  if (points.length === 0) {
    return { rate: null, sampleCount: 0 }
  }

  const rates = points.map((x) => x.rate).sort((a, b) => a - b)
  const q1 = percentile(rates, 0.25)
  const q3 = percentile(rates, 0.75)
  const iqr = q3 - q1
  const lower = Math.max(0, q1 - 1.5 * iqr)
  const upper = Math.min(0.9999, q3 + 1.5 * iqr)

  const filtered = points.filter((p) => p.rate >= lower && p.rate <= upper)
  if (filtered.length === 0) {
    return { rate: null, sampleCount: 0 }
  }

  // Recency + size weighted estimator to stabilize noisy per-tx tax readings.
  let weightedRate = 0
  let weightSum = 0
  for (const p of filtered) {
    const grossHuman = Number(p.gross) / 1e18
    const sizeWeight = Math.sqrt(Math.max(grossHuman, 1e-12))
    const recencyWeight = Math.exp(-p.idx / 80)
    const w = sizeWeight * recencyWeight
    weightedRate += p.rate * w
    weightSum += w
  }
  if (weightSum <= 0 || !Number.isFinite(weightedRate)) {
    return { rate: null, sampleCount: filtered.length }
  }

  const rate = Math.min(0.9999, Math.max(0, weightedRate / weightSum))
  return { rate, sampleCount: filtered.length }
}

async function resolveTaxModelStartTs(
  projectId: string,
  firstActiveBlock: number | null,
  fallbackTs: number | null,
): Promise<number | null> {
  if (!firstActiveBlock || firstActiveBlock <= 0) return fallbackTs

  const key = `tax:model-start-ts:${projectId}:${firstActiveBlock}`
  const cached = cacheGet<number>(key)
  if (cached && Number.isFinite(cached) && cached > 0) {
    return cached
  }

  try {
    const client = getClient()
    const block = await client.getBlock({
      blockNumber: BigInt(firstActiveBlock),
    })
    const ts = Number(block.timestamp)
    if (Number.isFinite(ts) && ts > 0) {
      cacheSet(key, ts, 10 * 60_000)
      return ts
    }
  } catch {
    // Non-fatal: fallback to first trade timestamp.
  }

  return fallbackTs
}

async function fetchGeckoPoolSnapshot(
  poolAddress: string,
): Promise<GeckoPoolSnapshot | null> {
  const key = `gecko:pool:${poolAddress.toLowerCase()}`
  const cached = cacheGet<GeckoPoolSnapshot>(key)
  if (cached) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddress}`
    const res = await proxyFetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return null

    const data = (await res.json()) as any
    const attrs = data?.data?.attributes
    if (!attrs) return null

    const priceUsd = Number(attrs.base_token_price_usd)
    const fdvUsd = Number(attrs.fdv_usd)
    const snapshot: GeckoPoolSnapshot = {
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
      fdvUsd: Number.isFinite(fdvUsd) && fdvUsd > 0 ? fdvUsd : null,
    }

    cacheSet(key, snapshot, 30_000)
    return snapshot
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /projects - List all projects
  fastify.get('/projects', async () => {
    return db.select().from(schema.projects).all()
  })

  // POST /projects - Add a new project
  fastify.post<{ Body: { tokenAddress: string; name?: string } }>(
    '/projects',
    async (request, reply) => {
      const { tokenAddress: rawAddr, name: providedName } = request.body || {}
      if (!rawAddr) {
        return reply.code(400).send({ error: 'tokenAddress is required' })
      }

      let tokenAddress: Address
      try {
        tokenAddress = getAddress(rawAddr) as Address
      } catch {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      // Check for duplicate
      const existing = db
        .select()
        .from(schema.projects)
        .all()
        .find(
          (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
        )
      if (existing) {
        return reply
          .code(409)
          .send({ error: 'Project already exists', id: existing.id })
      }

      // Read name from contract if not provided
      const client = getClient()
      let name = providedName || 'Unknown Token'
      try {
        if (!providedName) {
          name = (await client.readContract({
            address: tokenAddress,
            abi: TOKEN_ABI,
            functionName: 'name',
          })) as string
        }
      } catch {}

      const id = tokenAddress.toLowerCase().slice(2, 10)

      db.insert(schema.projects)
        .values({
          id,
          name,
          tokenAddress: getAddress(tokenAddress),
          virtualAddress: VIRTUAL_ADDRESS,
          phase: 'INTERNAL',
          createdAt: Math.floor(Date.now() / 1000),
        })
        .run()

      // Start indexer in background
      initializeProject(id)
        .then(() => runIndexerLoop(id))
        .catch((err) =>
          console.error(`[API] Failed to start indexer for ${id}:`, err),
        )

      return { id, name, tokenAddress }
    },
  )

  // POST /projects/:id/internal-market - Manually override internal market address
  fastify.post<{ Params: { id: string }; Body: { marketAddress: string } }>(
    '/projects/:id/internal-market',
    async (request, reply) => {
      const { id } = request.params
      const { marketAddress: rawMarketAddress } = request.body || ({} as any)

      const project = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get()
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }
      if (project.phase !== 'INTERNAL') {
        return reply
          .code(400)
          .send({ error: 'Project is not in INTERNAL phase' })
      }
      if (!rawMarketAddress) {
        return reply.code(400).send({ error: 'marketAddress is required' })
      }

      let marketAddress: Address
      try {
        marketAddress = getAddress(rawMarketAddress) as Address
      } catch {
        return reply.code(400).send({ error: 'Invalid marketAddress' })
      }

      const existingInternal = db
        .select()
        .from(schema.markets)
        .where(
          and(
            eq(schema.markets.projectId, id),
            eq(schema.markets.venue, 'INTERNAL'),
          ),
        )
        .get()

      if (existingInternal) {
        db.update(schema.markets)
          .set({ marketAddress })
          .where(eq(schema.markets.id, existingInternal.id))
          .run()
      } else {
        const latestBlock = Number(
          await getClient()
            .getBlockNumber()
            .catch(() => 0n),
        )
        db.insert(schema.markets)
          .values({
            id: `${id}-internal`,
            projectId: id,
            venue: 'INTERNAL',
            marketAddress,
            quoteToken: VIRTUAL_ADDRESS,
            startBlock:
              latestBlock > 0 ? latestBlock : project.firstActiveBlock || 0,
            startTs: Math.floor(Date.now() / 1000),
          })
          .onConflictDoNothing()
          .run()
      }

      // Clear stale persisted price so state recalculates from new market source.
      db.update(schema.projects)
        .set({ lastSpotPrice: null })
        .where(eq(schema.projects.id, id))
        .run()

      return {
        projectId: id,
        internalMarketAddress: marketAddress,
        updated: true,
      }
    },
  )

  // GET /projects/:id/state - Full project state
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/state',
    async (request, reply) => {
      const { id } = request.params

      const project = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get()

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      const markets = db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.projectId, id))
        .all()

      // Get VIRTUAL/USD price for conversions
      const virtualUsd = getVirtualUsdPrice()

      const internalMarket = markets.find((m) => m.venue === 'INTERNAL')
      let geckoPriceUsd: number | null = null
      let geckoFdvUsd: number | null = null
      let internalVirtualBalance: bigint | null = null
      let internalTokenBalance: bigint | null = null
      if (project.phase === 'INTERNAL' && internalMarket) {
        const gecko = await fetchGeckoPoolSnapshot(internalMarket.marketAddress)
        geckoPriceUsd = gecko?.priceUsd ?? null
        geckoFdvUsd = gecko?.fdvUsd ?? null
        try {
          const client = getClient()
          const [tokenBal, virtualBal] = await Promise.all([
            client.readContract({
              address: project.tokenAddress as Address,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [internalMarket.marketAddress as Address],
            }) as Promise<bigint>,
            client.readContract({
              address: VIRTUAL_ADDRESS as Address,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [internalMarket.marketAddress as Address],
            }) as Promise<bigint>,
          ])
          internalTokenBalance = tokenBal
          internalVirtualBalance = virtualBal
        } catch {
          // Non-fatal: leave as null if balances cannot be read.
        }
      }

      // Get spot price.
      // INTERNAL priority: in-memory -> DB -> internal reserve-derived -> last trade
      // EXTERNAL priority: in-memory -> DB -> last trade
      const priceState = getPriceState(id)
      let spotPrice: number | null = priceState?.spotPrice ?? null

      // Fallback 1: persisted price in DB
      if (spotPrice === null && project.lastSpotPrice) {
        spotPrice = project.lastSpotPrice
      }

      // Fallback 2: last trade price
      if (spotPrice === null) {
        const lastTrade = db
          .select()
          .from(schema.trades)
          .where(eq(schema.trades.projectId, id))
          .orderBy(desc(schema.trades.blockNumber))
          .limit(1)
          .get()
        spotPrice = lastTrade?.priceQuotePerToken || null
      }

      // Fallback 3 (INTERNAL only): Gecko pool price -> convert USD to VIRTUAL
      if (
        spotPrice === null &&
        geckoPriceUsd !== null &&
        virtualUsd !== null &&
        virtualUsd > 0
      ) {
        spotPrice = geckoPriceUsd / virtualUsd
      }

      // Fallback 4 (INTERNAL only): derive spot price from internal market balances.
      // price = virtualBalance / tokenBalance
      if (spotPrice === null && project.phase === 'INTERNAL') {
        if (internalMarket) {
          try {
            const tokenBal = internalTokenBalance ?? 0n
            const virtualBal = internalVirtualBalance ?? 0n

            if (tokenBal > 0n && virtualBal > 0n) {
              spotPrice = Number(virtualBal) / Number(tokenBal)
            }
          } catch {
            // Non-fatal: keep null if balances cannot be read.
          }
        }
      }

      // Compute FDV/EFDV from cached price (no RPC)
      let fdv: number | null = null
      let efdv: number | null = null
      const firstTrade = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .orderBy(asc(schema.trades.blockNumber))
        .limit(1)
        .get()
      const taxModelStartTs = await resolveTaxModelStartTs(
        id,
        project.firstActiveBlock,
        firstTrade?.ts ?? null,
      )

      let buyTaxRate: number | null
      if (project.phase === 'INTERNAL') {
        // INTERNAL: always use decay model from launch/open timestamp.
        buyTaxRate = taxModelStartTs
          ? getDecayTaxRate(taxModelStartTs, Math.floor(Date.now() / 1000))
          : 0.01
      } else {
        // EXTERNAL: keep observed+fallback blend for robustness.
        const observedTax = computeObservedBuyTaxRate(id)
        const fallbackTax = await getCurrentBuyTaxRate(
          project.tokenAddress as Address,
          taxModelStartTs,
        )
        buyTaxRate = observedTax.rate
        if (buyTaxRate === null) {
          buyTaxRate = fallbackTax
        } else if (observedTax.sampleCount < 5) {
          // Low sample count: blend with fallback source for stability.
          buyTaxRate = buyTaxRate * 0.5 + fallbackTax * 0.5
        }
      }
      if (buyTaxRate !== null && Number.isFinite(buyTaxRate)) {
        buyTaxRate = Math.max(0.01, buyTaxRate)
      }

      if (spotPrice !== null) {
        const totalSupply = project.totalSupply
          ? BigInt(project.totalSupply)
          : BigInt('1000000000000000000000000000')

        const result = computeFdvEfdv(spotPrice, totalSupply, buyTaxRate)
        fdv = result.fdv
        efdv = result.efdv
      }

      // Prefer Gecko FDV for INTERNAL pools if available.
      if (
        geckoFdvUsd !== null &&
        project.phase === 'INTERNAL' &&
        virtualUsd !== null &&
        virtualUsd > 0
      ) {
        fdv = geckoFdvUsd / virtualUsd
        efdv = buyTaxRate && buyTaxRate < 1 ? fdv / (1 - buyTaxRate) : fdv
      }

      // Graduation progress (estimated from cumulative VIRTUAL inflows to market)
      let graduationProgress: number | null = null
      if (project.phase === 'INTERNAL') {
        const threshold = BigInt('42000000000000000000000') // 42,000 VIRTUAL in wei
        if (internalVirtualBalance !== null) {
          graduationProgress = Math.min(
            1,
            Number(internalVirtualBalance) / Number(threshold),
          )
        } else {
          graduationProgress = null
        }
      } else {
        graduationProgress = 1
      }

      // Tax totals
      const taxSummary = computeTaxSummary(
        id,
        project.tokenAddress,
        project.graduatedAt ?? null,
      )
      const buybackTaxProgress = computeBuybackTaxProgress(
        id,
        project.taxRecipient,
        config.buybackExecutorAddress,
        project.graduatedAt,
      )

      return {
        project: project as any,
        markets: markets as any[],
        spotPrice,
        spotPriceUsd:
          geckoPriceUsd !== null
            ? geckoPriceUsd
            : spotPrice !== null && virtualUsd !== null
              ? spotPrice * virtualUsd
              : null,
        fdv,
        fdvUsd:
          geckoFdvUsd !== null
            ? geckoFdvUsd
            : fdv !== null && virtualUsd !== null
              ? fdv * virtualUsd
              : null,
        efdv,
        efdvUsd:
          efdv !== null && virtualUsd !== null ? efdv * virtualUsd : null,
        buyTaxRate,
        graduationProgress,
        internalMarketAddress: internalMarket?.marketAddress ?? null,
        internalVirtualBalance:
          internalVirtualBalance !== null
            ? internalVirtualBalance.toString()
            : null,
        totalTaxCollectedVirtual: taxSummary.actualVirtual,
        totalTaxCollectedToken: taxSummary.actualToken,
        graduationTaxVirtual: buybackTaxProgress?.graduationTaxVirtual ?? null,
        buybackSpentVirtual: buybackTaxProgress?.buybackSpentVirtual ?? null,
        remainingTaxVirtual: buybackTaxProgress?.remainingTaxVirtual ?? null,
        virtualUsdPrice: virtualUsd,
        taxModelStartTs,
      }
    },
  )

  // GET /projects/:id/efdv/layers - Layered EFDV dashboard (prelaunch/live)
  fastify.get<{
    Params: { id: string }
    Querystring: {
      mode?: 'prelaunch' | 'live'
      prebuyRatio?: string
      baseFdvVirtual?: string
    }
  }>('/projects/:id/efdv/layers', async (request, reply) => {
    const { id } = request.params
    const mode = request.query.mode === 'live' ? 'live' : 'prelaunch'
    const prebuyRatioRaw = request.query.prebuyRatio
    const prebuyRatio = prebuyRatioRaw ? Number(prebuyRatioRaw) : 0
    if (
      !Number.isFinite(prebuyRatio) ||
      prebuyRatio < 0 ||
      prebuyRatio > 0.99
    ) {
      return reply
        .code(400)
        .send({ error: 'prebuyRatio must be between 0 and 0.99' })
    }
    const baseFdvRaw = request.query.baseFdvVirtual
    const parsedBaseFdv =
      baseFdvRaw !== undefined ? Number(baseFdvRaw) : undefined
    if (
      parsedBaseFdv !== undefined &&
      (!Number.isFinite(parsedBaseFdv) || parsedBaseFdv <= 0)
    ) {
      return reply
        .code(400)
        .send({ error: 'baseFdvVirtual must be a positive number' })
    }

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    const totalSupply =
      project.totalSupply && BigInt(project.totalSupply) > 0n
        ? BigInt(project.totalSupply)
        : await readTotalSupply(project.tokenAddress as Address)

    const priceState = getPriceState(id)
    let spotPrice: number | null =
      priceState?.spotPrice ?? project.lastSpotPrice ?? null
    if (spotPrice === null) {
      const lastTrade = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
        .limit(1)
        .get()
      spotPrice = lastTrade?.priceQuotePerToken || null
    }

    const useLiveSpot = mode === 'live' && spotPrice !== null && spotPrice > 0
    let basePrice = 0
    if (useLiveSpot) {
      basePrice = spotPrice as number
    } else if (parsedBaseFdv !== undefined) {
      const supplyFloat = Number(totalSupply) / 1e18
      if (!Number.isFinite(supplyFloat) || supplyFloat <= 0) {
        return reply
          .code(400)
          .send({ error: 'Cannot derive base price from invalid total supply' })
      }
      basePrice = parsedBaseFdv / supplyFloat
    } else {
      basePrice = deriveLaunchCurveBasePrice(totalSupply)
    }
    const result = computeLayeredEfdv(
      totalSupply,
      basePrice,
      undefined,
      useLiveSpot ? 'LIVE_SPOT' : 'LAUNCH_CURVE_DERIVED',
      prebuyRatio,
    )

    return {
      projectId: id,
      mode,
      basePrice: result.basePrice,
      priceSource: result.priceSource,
      taxModel: result.taxModel,
      prebuyRatio: result.prebuyRatio,
      prebuyMultiplier: result.prebuyMultiplier,
      totalSupply: totalSupply.toString(),
      layers: result.layers,
    }
  })

  // GET /projects/:id/probability/marketcap-threshold - Probability of reaching market cap target
  fastify.get<{
    Params: { id: string }
    Querystring: { target?: string; horizon?: string }
  }>(
    '/projects/:id/probability/marketcap-threshold',
    async (request, reply) => {
      const { id } = request.params
      const targetMarketCapUsd = Number(request.query.target || '0')
      const horizonHours = Math.max(
        1,
        Number(request.query.horizon || config.probabilityModelWindowHours),
      )
      if (!Number.isFinite(targetMarketCapUsd) || targetMarketCapUsd <= 0) {
        return reply
          .code(400)
          .send({ error: 'target must be a positive number (USD)' })
      }

      const project = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get()
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      const totalSupply =
        project.totalSupply && BigInt(project.totalSupply) > 0n
          ? BigInt(project.totalSupply)
          : await readTotalSupply(project.tokenAddress as Address)
      const supplyFloat = Number(totalSupply) / 1e18

      const priceState = getPriceState(id)
      let spotPrice: number | null =
        priceState?.spotPrice ?? project.lastSpotPrice ?? null
      if (spotPrice === null) {
        const lastTrade = db
          .select()
          .from(schema.trades)
          .where(eq(schema.trades.projectId, id))
          .orderBy(
            desc(schema.trades.blockNumber),
            desc(schema.trades.logIndex),
          )
          .limit(1)
          .get()
        spotPrice = lastTrade?.priceQuotePerToken || null
      }
      const virtualUsd = await getVirtualUsdPrice()
      const currentMarketCapUsd =
        spotPrice !== null && virtualUsd !== null
          ? spotPrice * supplyFloat * virtualUsd
          : null

      const firstTrade = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .orderBy(asc(schema.trades.blockNumber), asc(schema.trades.logIndex))
        .limit(1)
        .get()
      const taxModelStartTs = await resolveTaxModelStartTs(
        id,
        project.firstActiveBlock ?? null,
        firstTrade?.ts ?? null,
      )
      const buyTaxRate = await getCurrentBuyTaxRate(
        project.tokenAddress as Address,
        taxModelStartTs,
      )

      const progress = computeBuybackTaxProgress(
        id,
        project.taxRecipient,
        config.buybackExecutorAddress,
        project.graduatedAt,
      )
      const remainingBuybackVirtual = BigInt(
        progress?.remainingTaxVirtual || '0',
      )
      const remainingBuybackUsd =
        virtualUsd !== null
          ? (Number(remainingBuybackVirtual) / 1e18) * virtualUsd
          : 0

      const balances = db
        .select()
        .from(schema.tokenBalances)
        .where(eq(schema.tokenBalances.projectId, id))
        .all()
        .filter((b) => BigInt(b.balance) > 0n)
        .sort((a, b) =>
          BigInt(b.balance) > BigInt(a.balance)
            ? 1
            : BigInt(b.balance) < BigInt(a.balance)
              ? -1
              : 0,
        )
      const heldTop10 = balances
        .slice(0, 10)
        .reduce((acc, b) => acc + BigInt(b.balance), 0n)
      const totalHeld = balances.reduce((acc, b) => acc + BigInt(b.balance), 0n)
      const concentrationTop10 =
        totalHeld > 0n ? Number(heldTop10) / Number(totalHeld) : 0

      const nowTs = Math.floor(Date.now() / 1000)
      const windowTs = nowTs - Math.floor(horizonHours * 3600)
      const windowTrades = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .all()
        .filter((t) => t.ts >= windowTs)
      let buyVolume = 0n
      let sellVolume = 0n
      for (const t of windowTrades) {
        if (t.side === 'BUY') {
          buyVolume += BigInt(t.quoteInGross || t.quoteIn || '0')
        } else {
          sellVolume += BigInt(t.quoteOut || '0')
        }
      }
      const denom = buyVolume + sellVolume
      const buyMomentum =
        denom > 0n ? Number(buyVolume - sellVolume) / Number(denom) : 0

      const probability = computeThresholdProbability({
        targetMarketCapUsd,
        currentMarketCapUsd,
        remainingBuybackUsd,
        buyTaxRate: buyTaxRate ?? 0.01,
        concentrationTop10,
        buyMomentum,
        sampleTrades: windowTrades.length,
        horizonHours,
      })

      return {
        projectId: id,
        targetMarketCapUsd,
        horizonHours,
        probability: probability.probability,
        confidence: probability.confidence,
        modelVersion: probability.modelVersion,
        trainedAt: probability.trainedAt,
        currentMarketCapUsd,
        factors: probability.factors,
        featureSnapshot: {
          remainingBuybackUsd,
          buyTaxRate: buyTaxRate ?? 0.01,
          concentrationTop10,
          buyMomentum,
          sampleTrades: windowTrades.length,
        },
      }
    },
  )

  // GET /projects/:id/whales - Top holders by token balance
  fastify.get<{
    Params: { id: string }
    Querystring: {
      limit?: string
      excludeSystem?: string
      includeTransferOnly?: string
      onlyEoa?: string
    }
  }>('/projects/:id/whales', async (request, reply) => {
    const { id } = request.params
    const limit = parseInt(request.query.limit || '20', 10)
    const excludeSystem = parseBoolParam(request.query.excludeSystem, true)
    const includeTransferOnly = parseBoolParam(
      request.query.includeTransferOnly,
      false,
    )
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )

    // Query token_balances table - sorted by actual holdings
    const balanceRows = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()

    // Filter out excluded + zero balance, sort by balance DESC
    let filtered = balanceRows
      .filter((r) => {
        if (excludeSystem && excludedReasons.has(r.address.toLowerCase()))
          return false
        const bal = BigInt(r.balance)
        return bal > 0n
      })
      .sort((a, b) => {
        const aBal = BigInt(a.balance)
        const bBal = BigInt(b.balance)
        if (bBal > aBal) return 1
        if (bBal < aBal) return -1
        return 0
      })

    if (onlyEoa) {
      const eoaFlags = await Promise.all(
        filtered.map(async (row) => ({
          row,
          isEoa: await isEoaAddressWithCache(row.address),
        })),
      )
      filtered = eoaFlags.filter((x) => x.isEoa).map((x) => x.row)
    }
    filtered = filtered.slice(0, limit)

    // Build address cost lookup for enrichment
    const costRows = db
      .select()
      .from(schema.addressCosts)
      .where(eq(schema.addressCosts.projectId, id))
      .all()

    const costMap = new Map(costRows.map((c) => [c.address.toLowerCase(), c]))

    const whaleEntries: WhaleEntry[] = filtered.map((b) => {
      const cost = costMap.get(b.address.toLowerCase())
      const snapshot = getWhaleCostSnapshot(cost)

      // Tax paid = gross - net
      const taxPaid =
        snapshot.spentGross > snapshot.spentNet
          ? snapshot.spentGross - snapshot.spentNet
          : 0n

      return {
        address: b.address,
        balance: b.balance,
        hasTrades: Boolean(cost),
        dataCompleteness: cost ? 'TRADES_BASED' : 'TRANSFER_ONLY',
        spentQuoteGross: snapshot.spentGross.toString(),
        spentQuoteNet: snapshot.spentNet.toString(),
        taxPaid: taxPaid.toString(),
        tokensReceived: snapshot.tokensReceived.toString(),
        tokensSold: snapshot.tokensSold.toString(),
        remainingTokens: snapshot.remainingTokens.toString(),
        remainingCostNet: snapshot.remainingCostNet.toString(),
        remainingCostGross: snapshot.remainingCostGross.toString(),
        quoteReceived: snapshot.quoteReceived.toString(),
        avgCost: cost?.avgCost ?? null, // NET avg cost
        avgCostGross: cost?.avgCostGross ?? null, // GROSS avg cost (including tax)
        avgCostOpen: snapshot.avgCostOpen,
        avgCostOpenGross: snapshot.avgCostOpenGross,
        realizedPnl: snapshot.realizedPnl,
      }
    })

    if (includeTransferOnly) return whaleEntries
    return whaleEntries.filter((w) => w.hasTrades)
  })

  // GET /projects/:id/whales/internal - Internal-market whale profile
  fastify.get<{
    Params: { id: string }
    Querystring: { limit?: string; excludeSystem?: string; onlyEoa?: string }
  }>('/projects/:id/whales/internal', async (request, reply) => {
    const { id } = request.params
    const limit = parseInt(request.query.limit || '20', 10)
    const excludeSystem = parseBoolParam(request.query.excludeSystem, true)
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )
    let balances = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()
      .filter((r) => {
        if (excludeSystem && excludedReasons.has(r.address.toLowerCase()))
          return false
        return BigInt(r.balance) > 0n
      })
      .sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance)
          ? 1
          : BigInt(b.balance) < BigInt(a.balance)
            ? -1
            : 0,
      )

    if (onlyEoa) {
      const eoaFlags = await Promise.all(
        balances.map(async (row) => ({
          row,
          isEoa: await isEoaAddressWithCache(row.address),
        })),
      )
      balances = eoaFlags.filter((x) => x.isEoa).map((x) => x.row)
    }
    balances = balances.slice(0, limit)

    const internalTrades = db
      .select()
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.projectId, id),
          eq(schema.trades.venue, 'INTERNAL'),
        ),
      )
      .all()
    const allBuys = db
      .select()
      .from(schema.trades)
      .where(
        and(eq(schema.trades.projectId, id), eq(schema.trades.side, 'BUY')),
      )
      .all()

    const byAddress = new Map<
      string,
      {
        buyGross: bigint
        buyNet: bigint
        buyToken: bigint
        sellToken: bigint
        sellQuote: bigint
      }
    >()
    for (const t of internalTrades) {
      const key = t.trader.toLowerCase()
      const curr = byAddress.get(key) || {
        buyGross: 0n,
        buyNet: 0n,
        buyToken: 0n,
        sellToken: 0n,
        sellQuote: 0n,
      }
      if (t.side === 'BUY') {
        const gross = t.quoteInGross
          ? BigInt(t.quoteInGross)
          : t.quoteIn
            ? BigInt(t.quoteIn)
            : 0n
        const net = t.quoteIn ? BigInt(t.quoteIn) : gross
        const token = t.tokenOut ? BigInt(t.tokenOut) : 0n
        curr.buyGross += gross
        curr.buyNet += net
        curr.buyToken += token
      } else {
        const token = t.tokenIn ? BigInt(t.tokenIn) : 0n
        const out = t.quoteOut ? BigInt(t.quoteOut) : 0n
        curr.sellToken += token
        curr.sellQuote += out
      }
      byAddress.set(key, curr)
    }
    const allBuyGrossByAddress = new Map<string, bigint>()
    for (const t of allBuys) {
      const key = t.trader.toLowerCase()
      const gross = t.quoteInGross
        ? BigInt(t.quoteInGross)
        : t.quoteIn
          ? BigInt(t.quoteIn)
          : 0n
      allBuyGrossByAddress.set(
        key,
        (allBuyGrossByAddress.get(key) || 0n) + gross,
      )
    }

    const costRows = db
      .select()
      .from(schema.addressCosts)
      .where(eq(schema.addressCosts.projectId, id))
      .all()
    const costMap = new Map(costRows.map((c) => [c.address.toLowerCase(), c]))

    const totalSupply =
      project.totalSupply && BigInt(project.totalSupply) > 0n
        ? BigInt(project.totalSupply)
        : balances.reduce((acc, b) => acc + BigInt(b.balance), 0n)

    const priceState = getPriceState(id)
    let spotPrice: number | null =
      priceState?.spotPrice ?? project.lastSpotPrice ?? null
    if (spotPrice === null) {
      const lastTrade = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
        .limit(1)
        .get()
      spotPrice = lastTrade?.priceQuotePerToken || null
    }

    const decisions = new Map<string, WhaleDecision>()
    for (const b of balances) {
      decisions.set(
        b.address.toLowerCase(),
        await evaluateWhaleDecision(b.address, onlyEoa),
      )
    }

    const profiles = balances
      .filter((b) => decisions.get(b.address.toLowerCase())?.included === true)
      .map((b) => {
        const key = b.address.toLowerCase()
        const aggr = byAddress.get(key) || {
          buyGross: 0n,
          buyNet: 0n,
          buyToken: 0n,
          sellToken: 0n,
          sellQuote: 0n,
        }
        const snapshot = getWhaleCostSnapshot(costMap.get(key))
        const externalBuyGross =
          (allBuyGrossByAddress.get(key) || 0n) - aggr.buyGross
        const allVenueBuyGross = allBuyGrossByAddress.get(key) || 0n
        const decision = decisions.get(key)!
        const avgBuyTaxRate =
          aggr.buyGross > 0n
            ? Number(aggr.buyGross - aggr.buyNet) / Number(aggr.buyGross)
            : null
        const allBuysGross = allVenueBuyGross
        const allBuysNet = allBuys
          .filter((t) => t.trader.toLowerCase() === key)
          .reduce((acc, t) => {
            const net = t.quoteIn ? BigInt(t.quoteIn) : 0n
            return acc + net
          }, 0n)
        const fallbackRate =
          allBuysGross > 0n
            ? Number(allBuysGross - allBuysNet) / Number(allBuysGross)
            : null
        const taxSource: 'INTERNAL_ONLY' | 'ALL_BUYS' =
          avgBuyTaxRate !== null ? 'INTERNAL_ONLY' : 'ALL_BUYS'
        const avgCostGross =
          aggr.buyToken > 0n
            ? Number(aggr.buyGross) / Number(aggr.buyToken)
            : null
        const avgCostNet =
          aggr.buyToken > 0n
            ? Number(aggr.buyNet) / Number(aggr.buyToken)
            : null
        const holdingShare =
          totalSupply > 0n ? Number(BigInt(b.balance)) / Number(totalSupply) : 0
        const unrealizedPnl =
          spotPrice !== null && snapshot.remainingTokens > 0n
            ? (Number(snapshot.remainingTokens) * spotPrice -
                Number(snapshot.remainingCostGross)) /
              1e18
            : null

        return {
          address: b.address,
          balance: b.balance,
          holdingShare,
          buyVolumeGross: aggr.buyGross.toString(),
          externalBuyGross:
            externalBuyGross > 0n ? externalBuyGross.toString() : '0',
          allVenueBuyGross: allVenueBuyGross.toString(),
          buyVolumeNet: aggr.buyNet.toString(),
          buyVolumeToken: aggr.buyToken.toString(),
          avgBuyTaxRate: avgBuyTaxRate ?? fallbackRate,
          avgBuyTaxRateSource: taxSource,
          avgCostGross,
          avgCostNet,
          realizedPnl: snapshot.realizedPnl,
          unrealizedPnl,
          remainingTokens: snapshot.remainingTokens.toString(),
          totalValueUsd: decision.totalValueUsd,
          wealthUnknown: decision.wealthUnknown,
          debugReason: decision.reason,
        }
      })
      .filter((p) => BigInt(p.buyVolumeGross) > 0n)

    return {
      totalSupply: totalSupply.toString(),
      count: profiles.length,
      items: profiles,
    }
  })

  // GET /projects/:id/whales/debug/:address - Explain include/exclude decision
  fastify.get<{
    Params: { id: string; address: string }
    Querystring: { onlyEoa?: string }
  }>('/projects/:id/whales/debug/:address', async (request, reply) => {
    const { id, address } = request.params
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    let normalized: Address
    try {
      normalized = getAddress(address) as Address
    } catch {
      return reply.code(400).send({ error: 'Invalid address' })
    }
    const lower = normalized.toLowerCase()
    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )
    const excludedReason = excludedReasons.get(lower) || null

    const trades = db
      .select()
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.projectId, id),
          sql`lower(${schema.trades.trader}) = ${lower}`,
        ),
      )
      .all()
    const internalBuys = trades.filter(
      (t) => t.side === 'BUY' && t.venue === 'INTERNAL',
    )
    const externalBuys = trades.filter(
      (t) => t.side === 'BUY' && t.venue === 'EXTERNAL',
    )
    const internalBuyGross = internalBuys.reduce((acc, t) => {
      const gross = t.quoteInGross
        ? BigInt(t.quoteInGross)
        : t.quoteIn
          ? BigInt(t.quoteIn)
          : 0n
      return acc + gross
    }, 0n)
    const externalBuyGross = externalBuys.reduce((acc, t) => {
      const gross = t.quoteInGross
        ? BigInt(t.quoteInGross)
        : t.quoteIn
          ? BigInt(t.quoteIn)
          : 0n
      return acc + gross
    }, 0n)
    const decision = await evaluateWhaleDecision(lower, onlyEoa)

    return {
      projectId: id,
      address: normalized,
      excludedReason,
      onlyEoa,
      decision,
      tradeCounts: {
        total: trades.length,
        internalBuys: internalBuys.length,
        externalBuys: externalBuys.length,
      },
      buyGross: {
        internal: internalBuyGross.toString(),
        external: externalBuyGross.toString(),
        all: (internalBuyGross + externalBuyGross).toString(),
      },
    }
  })

  // GET /projects/:id/whales/activity - Whale trade activity stream
  fastify.get<{
    Params: { id: string }
    Querystring: {
      limit?: string
      offset?: string
      threshold?: string
      excludeSystem?: string
      onlyEoa?: string
      includeClosed?: string
    }
  }>('/projects/:id/whales/activity', async (request, reply) => {
    const { id } = request.params
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200)
    const offset = Math.max(parseInt(request.query.offset || '0', 10), 0)
    const thresholdWei = request.query.threshold
      ? BigInt(request.query.threshold)
      : config.whaleThresholdSingleTrade // default 1000 V
    const excludeSystem = parseBoolParam(request.query.excludeSystem, true)
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)
    const includeClosed = parseBoolParam(request.query.includeClosed, false)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    const rows = db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.projectId, id))
      .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
      .all()

    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )
    let filtered = rows.filter((t) => {
      if (excludeSystem && excludedReasons.has(t.trader.toLowerCase()))
        return false
      if (t.side === 'BUY') {
        const gross = t.quoteInGross
          ? BigInt(t.quoteInGross)
          : t.quoteIn
            ? BigInt(t.quoteIn)
            : 0n
        return gross >= thresholdWei
      }
      const tokenIn = t.tokenIn ? BigInt(t.tokenIn) : 0n
      return tokenIn >= thresholdWei
    })

    const unique = [...new Set(filtered.map((t) => t.trader.toLowerCase()))]
    const decisionMap = new Map<string, WhaleDecision>()
    await Promise.all(
      unique.map(async (addr) => {
        decisionMap.set(addr, await evaluateWhaleDecision(addr, onlyEoa))
      }),
    )
    filtered = filtered.filter(
      (t) => decisionMap.get(t.trader.toLowerCase())?.included === true,
    )

    const balanceRows = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()
    const balanceMap = new Map(
      balanceRows.map((b) => [b.address.toLowerCase(), b.balance]),
    )
    if (!includeClosed) {
      filtered = filtered.filter(
        (t) => BigInt(balanceMap.get(t.trader.toLowerCase()) || '0') > 0n,
      )
    }

    const costRows = db
      .select()
      .from(schema.addressCosts)
      .where(eq(schema.addressCosts.projectId, id))
      .all()
    const costMap = new Map(costRows.map((c) => [c.address.toLowerCase(), c]))

    const items = filtered.slice(offset, offset + limit).map((t) => {
      const snapshot = getWhaleCostSnapshot(costMap.get(t.trader.toLowerCase()))
      const gross = t.quoteInGross
        ? BigInt(t.quoteInGross)
        : t.quoteIn
          ? BigInt(t.quoteIn)
          : 0n
      const net = t.quoteIn ? BigInt(t.quoteIn) : gross
      const tokenAmount =
        t.side === 'BUY'
          ? t.tokenOut
            ? BigInt(t.tokenOut)
            : 0n
          : t.tokenIn
            ? BigInt(t.tokenIn)
            : 0n
      const taxRate =
        t.side === 'BUY' && gross > 0n
          ? Number(gross - net) / Number(gross)
          : null
      const baselineAvgCostGross = snapshot.avgCostOpenGross
      const realizedPnlEstimate =
        t.side === 'SELL' &&
        baselineAvgCostGross !== null &&
        t.quoteOut &&
        t.tokenIn
          ? (Number(BigInt(t.quoteOut)) -
              Number(BigInt(t.tokenIn)) * baselineAvgCostGross) /
            1e18
          : null
      const decision = decisionMap.get(t.trader.toLowerCase())
      const taxRateSource: 'INTERNAL_ONLY' | 'ALL_BUYS' =
        t.venue === 'INTERNAL' ? 'INTERNAL_ONLY' : 'ALL_BUYS'

      return {
        txHash: t.txHash,
        blockNumber: t.blockNumber,
        ts: t.ts,
        venue: t.venue,
        address: t.trader,
        side: t.side,
        action: t.side === 'BUY' ? 'ADD' : 'REDUCE',
        quoteGross: gross.toString(),
        quoteNet: net.toString(),
        tokenAmount: tokenAmount.toString(),
        taxRate,
        taxRateSource,
        baselineAvgCostGross,
        realizedPnlEstimate,
        totalValueUsd: decision?.totalValueUsd ?? null,
        wealthUnknown: decision?.wealthUnknown ?? false,
        debugReason: decision?.reason ?? 'OK',
      }
    })

    return {
      limit,
      offset,
      total: filtered.length,
      threshold: thresholdWei.toString(),
      items,
    }
  })

  // GET /projects/:id/whales/activity/:address - Whale activity stream for a specific address
  fastify.get<{
    Params: { id: string; address: string }
    Querystring: {
      limit?: string
      offset?: string
      threshold?: string
      excludeSystem?: string
      onlyEoa?: string
      includeClosed?: string
    }
  }>('/projects/:id/whales/activity/:address', async (request, reply) => {
    const { id, address } = request.params
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200)
    const offset = Math.max(parseInt(request.query.offset || '0', 10), 0)
    const thresholdWei = request.query.threshold
      ? BigInt(request.query.threshold)
      : config.whaleThresholdSingleTrade // default 1000 V
    const excludeSystem = parseBoolParam(request.query.excludeSystem, true)
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)
    const includeClosed = parseBoolParam(request.query.includeClosed, false)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    let normalizedAddress: string
    try {
      normalizedAddress = getAddress(address).toLowerCase()
    } catch {
      return reply.code(400).send({ error: 'Invalid address' })
    }

    const rows = db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.projectId, id))
      .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
      .all()

    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )
    let filtered = rows.filter((t) => {
      if (t.trader.toLowerCase() !== normalizedAddress) return false
      if (excludeSystem && excludedReasons.has(t.trader.toLowerCase()))
        return false
      if (t.side === 'BUY') {
        const gross = t.quoteInGross
          ? BigInt(t.quoteInGross)
          : t.quoteIn
            ? BigInt(t.quoteIn)
            : 0n
        return gross >= thresholdWei
      }
      const tokenIn = t.tokenIn ? BigInt(t.tokenIn) : 0n
      return tokenIn >= thresholdWei
    })

    const decision = await evaluateWhaleDecision(normalizedAddress, onlyEoa)
    if (!decision.included) {
      filtered = []
    }

    const balanceRows = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()
    const balanceMap = new Map(
      balanceRows.map((b) => [b.address.toLowerCase(), b.balance]),
    )
    if (!includeClosed) {
      filtered = filtered.filter(
        (t) => BigInt(balanceMap.get(t.trader.toLowerCase()) || '0') > 0n,
      )
    }

    const costRows = db
      .select()
      .from(schema.addressCosts)
      .where(eq(schema.addressCosts.projectId, id))
      .all()
    const costMap = new Map(costRows.map((c) => [c.address.toLowerCase(), c]))

    const items = filtered.slice(offset, offset + limit).map((t) => {
      const snapshot = getWhaleCostSnapshot(costMap.get(t.trader.toLowerCase()))
      const gross = t.quoteInGross
        ? BigInt(t.quoteInGross)
        : t.quoteIn
          ? BigInt(t.quoteIn)
          : 0n
      const net = t.quoteIn ? BigInt(t.quoteIn) : gross
      const tokenAmount =
        t.side === 'BUY'
          ? t.tokenOut
            ? BigInt(t.tokenOut)
            : 0n
          : t.tokenIn
            ? BigInt(t.tokenIn)
            : 0n
      const taxRate =
        t.side === 'BUY' && gross > 0n
          ? Number(gross - net) / Number(gross)
          : null
      const baselineAvgCostGross = snapshot.avgCostOpenGross
      const realizedPnlEstimate =
        t.side === 'SELL' &&
        baselineAvgCostGross !== null &&
        t.quoteOut &&
        t.tokenIn
          ? (Number(BigInt(t.quoteOut)) -
              Number(BigInt(t.tokenIn)) * baselineAvgCostGross) /
            1e18
          : null
      const taxRateSource: 'INTERNAL_ONLY' | 'ALL_BUYS' =
        t.venue === 'INTERNAL' ? 'INTERNAL_ONLY' : 'ALL_BUYS'

      return {
        txHash: t.txHash,
        blockNumber: t.blockNumber,
        ts: t.ts,
        venue: t.venue,
        address: t.trader,
        side: t.side,
        action: t.side === 'BUY' ? 'ADD' : 'REDUCE',
        quoteGross: gross.toString(),
        quoteNet: net.toString(),
        tokenAmount: tokenAmount.toString(),
        taxRate,
        taxRateSource,
        baselineAvgCostGross,
        realizedPnlEstimate,
        totalValueUsd: decision.totalValueUsd ?? null,
        wealthUnknown: decision.wealthUnknown ?? false,
        debugReason: decision.reason ?? 'OK',
      }
    })

    return {
      limit,
      offset,
      total: filtered.length,
      threshold: thresholdWei.toString(),
      items,
    }
  })

  // GET /projects/:id/whales/pressure - Concentration and pressure tiers
  fastify.get<{
    Params: { id: string }
    Querystring: { onlyEoa?: string }
  }>('/projects/:id/whales/pressure', async (request, reply) => {
    const { id } = request.params
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)
    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )
    let balances = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()
      .filter(
        (r) =>
          !excludedReasons.has(r.address.toLowerCase()) &&
          BigInt(r.balance) > 0n,
      )
      .sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance)
          ? 1
          : BigInt(b.balance) < BigInt(a.balance)
            ? -1
            : 0,
      )

    if (onlyEoa && balances.length > 0) {
      const eoaFlags = await Promise.all(
        balances.map(async (row) => ({
          row,
          isEoa: await isEoaAddressWithCache(row.address),
        })),
      )
      balances = eoaFlags.filter((x) => x.isEoa).map((x) => x.row)
    }

    const totalSupply =
      project.totalSupply && BigInt(project.totalSupply) > 0n
        ? BigInt(project.totalSupply)
        : balances.reduce((acc, b) => acc + BigInt(b.balance), 0n)

    const topNs = [5, 10, 20]
    const summaries = topNs.map((topN) => {
      const totalHeld = balances
        .slice(0, topN)
        .reduce((acc, b) => acc + BigInt(b.balance), 0n)
      const heldShare =
        totalSupply > 0n ? Number(totalHeld) / Number(totalSupply) : 0
      return {
        topN,
        totalHeld: totalHeld.toString(),
        totalSupply: totalSupply.toString(),
        heldShare,
      }
    })

    const topForTiers = balances.slice(0, 20)
    const heldTop20 = topForTiers.reduce(
      (acc, b) => acc + BigInt(b.balance),
      0n,
    )
    const priceState = getPriceState(id)
    let spotPrice = priceState?.spotPrice ?? project.lastSpotPrice ?? null
    if (spotPrice === null) {
      const lastTrade = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
        .limit(1)
        .get()
      spotPrice = lastTrade?.priceQuotePerToken || null
    }

    const tiers = [0.1, 0.25, 0.5].map((sellShareOfHeld) => {
      const sellAmountToken =
        (heldTop20 * BigInt(Math.floor(sellShareOfHeld * 10000))) / 10000n
      const estimatedNotionalV =
        spotPrice !== null ? (Number(sellAmountToken) * spotPrice) / 1e18 : null
      return {
        sellShareOfHeld,
        sellAmountToken: sellAmountToken.toString(),
        avgCostGross: null,
        estimatedNotionalV,
      }
    })

    const topWhales = balances.slice(0, 20).map((b) => ({
      address: b.address,
      balance: b.balance,
      shareOfSupply:
        totalSupply > 0n ? Number(BigInt(b.balance)) / Number(totalSupply) : 0,
    }))

    return {
      summaries,
      tiers,
      topWhales,
    }
  })

  // POST /projects/:id/simulate-dump - Worst-case dump simulation
  fastify.post<{
    Params: { id: string }
    Body: {
      sellAmount?: string
      sellShare?: number
      topN?: number
      mode?: 'IDEAL' | 'CONSERVATIVE'
      onlyEoa?: boolean
    }
  }>('/projects/:id/simulate-dump', async (request, reply) => {
    const { id } = request.params
    const {
      sellAmount,
      sellShare,
      topN = 20,
      mode = 'IDEAL',
      onlyEoa = true,
    } = request.body || {}

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    const priceState = getPriceState(id)
    if (
      !priceState ||
      priceState.reserveToken <= 0n ||
      priceState.reserveVirtual <= 0n
    ) {
      return reply
        .code(400)
        .send({ error: 'No valid reserve state for simulation' })
    }

    let sellAmountToken = sellAmount ? BigInt(sellAmount) : 0n
    if (sellAmountToken <= 0n) {
      const excludedReasons = buildExcludedAddressReasonMap(
        id,
        project.tokenAddress,
      )
      const balances = db
        .select()
        .from(schema.tokenBalances)
        .where(eq(schema.tokenBalances.projectId, id))
        .all()
        .filter(
          (r) =>
            !excludedReasons.has(r.address.toLowerCase()) &&
            BigInt(r.balance) > 0n,
        )
        .sort((a, b) =>
          BigInt(b.balance) > BigInt(a.balance)
            ? 1
            : BigInt(b.balance) < BigInt(a.balance)
              ? -1
              : 0,
        )
      const filtered = onlyEoa
        ? (
            await Promise.all(
              balances.map(async (row) => ({
                row,
                isEoa: await isEoaAddressWithCache(row.address),
              })),
            )
          )
            .filter((x) => x.isEoa)
            .map((x) => x.row)
        : balances
      const topBalances = filtered.slice(0, topN)

      const held = topBalances.reduce((acc, b) => acc + BigInt(b.balance), 0n)
      const share =
        sellShare !== undefined ? Math.min(Math.max(sellShare, 0), 1) : 0.25
      sellAmountToken = (held * BigInt(Math.floor(share * 10000))) / 10000n
    }

    if (mode === 'CONSERVATIVE') {
      sellAmountToken = (sellAmountToken * 12000n) / 10000n
    }

    const simulation = simulateDump(
      priceState.reserveVirtual,
      priceState.reserveToken,
      sellAmountToken,
    )
    return {
      mode,
      simulation,
    }
  })

  // GET /projects/:id/whales/absorption - Can remaining tax absorb dump?
  fastify.get<{
    Params: { id: string }
    Querystring: {
      sellShare?: string
      topN?: string
      mode?: 'IDEAL' | 'CONSERVATIVE'
      onlyEoa?: string
    }
  }>('/projects/:id/whales/absorption', async (request, reply) => {
    const { id } = request.params
    const sellShareRaw = request.query.sellShare
      ? Number(request.query.sellShare)
      : 0.25
    const topN = request.query.topN ? parseInt(request.query.topN, 10) : 20
    const mode = request.query.mode || 'IDEAL'
    const onlyEoa = parseBoolParam(request.query.onlyEoa, true)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) return reply.code(404).send({ error: 'Project not found' })

    const priceState = getPriceState(id)
    if (
      !priceState ||
      priceState.reserveToken <= 0n ||
      priceState.reserveVirtual <= 0n
    ) {
      return reply
        .code(400)
        .send({ error: 'No valid reserve state for simulation' })
    }

    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )
    let balances = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()
      .filter(
        (r) =>
          !excludedReasons.has(r.address.toLowerCase()) &&
          BigInt(r.balance) > 0n,
      )
      .sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance)
          ? 1
          : BigInt(b.balance) < BigInt(a.balance)
            ? -1
            : 0,
      )

    if (onlyEoa && balances.length > 0) {
      const eoaFlags = await Promise.all(
        balances.map(async (row) => ({
          row,
          isEoa: await isEoaAddressWithCache(row.address),
        })),
      )
      balances = eoaFlags.filter((x) => x.isEoa).map((x) => x.row)
    }
    balances = balances.slice(0, topN)

    const held = balances.reduce((acc, b) => acc + BigInt(b.balance), 0n)
    const share = Math.min(Math.max(sellShareRaw, 0), 1)
    let sellAmountToken = (held * BigInt(Math.floor(share * 10000))) / 10000n
    if (mode === 'CONSERVATIVE') {
      sellAmountToken = (sellAmountToken * 12000n) / 10000n
    }

    const simulation = simulateDump(
      priceState.reserveVirtual,
      priceState.reserveToken,
      sellAmountToken,
    )

    const progress = computeBuybackTaxProgress(
      id,
      project.taxRecipient,
      config.buybackExecutorAddress,
      project.graduatedAt,
    )
    const remainingTaxVirtual = progress?.remainingTaxVirtual || '0'
    const remaining = BigInt(remainingTaxVirtual)
    const required = BigInt(simulation.requiredBuybackVirtual)
    const canAbsorb = remaining >= required
    const coverageRatio =
      required > 0n ? Number(remaining) / Number(required) : null

    return {
      remainingTaxVirtual,
      requiredBuybackVirtual: simulation.requiredBuybackVirtual,
      canAbsorb,
      coverageRatio,
      simulation,
    }
  })

  // GET /projects/:id/addresses/:address - Detailed cost/profile for one address
  fastify.get<{
    Params: { id: string; address: string }
    Querystring: { limit?: string }
  }>('/projects/:id/addresses/:address', async (request, reply) => {
    const { id, address: rawAddress } = request.params
    const limit = parseInt(request.query.limit || '30', 10)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    let normalizedAddress: Address
    try {
      normalizedAddress = getAddress(rawAddress) as Address
    } catch {
      return reply.code(400).send({ error: 'Invalid address' })
    }

    const normalizedLower = normalizedAddress.toLowerCase()
    const balanceRow = db
      .select()
      .from(schema.tokenBalances)
      .where(
        and(
          eq(schema.tokenBalances.projectId, id),
          eq(schema.tokenBalances.address, normalizedLower),
        ),
      )
      .get()

    const cost = db
      .select()
      .from(schema.addressCosts)
      .where(eq(schema.addressCosts.projectId, id))
      .all()
      .find((r) => r.address.toLowerCase() === normalizedLower)

    const spentNet = cost ? BigInt(cost.spentQuoteGross) : 0n
    const spentGross = cost ? BigInt(cost.spentQuoteGrossActual || '0') : 0n
    const tokensReceived = cost ? BigInt(cost.tokensReceived) : 0n
    const tokensSold = cost ? BigInt(cost.tokensSold) : 0n
    const quoteReceived = cost ? BigInt(cost.quoteReceived) : 0n
    const remainingTokens =
      tokensReceived > tokensSold ? tokensReceived - tokensSold : 0n

    const soldCostNet =
      tokensSold > 0n && tokensReceived > 0n
        ? (spentNet * tokensSold) / tokensReceived
        : 0n
    const soldCostGross =
      tokensSold > 0n && tokensReceived > 0n
        ? (spentGross * tokensSold) / tokensReceived
        : 0n

    const remainingCostNet =
      spentNet > soldCostNet ? spentNet - soldCostNet : 0n
    const remainingCostGross =
      spentGross > soldCostGross ? spentGross - soldCostGross : 0n
    const taxPaid = spentGross > spentNet ? spentGross - spentNet : 0n

    const avgCostOpen =
      remainingTokens > 0n
        ? Number(remainingCostNet) / Number(remainingTokens)
        : null
    const avgCostOpenGross =
      remainingTokens > 0n
        ? Number(remainingCostGross) / Number(remainingTokens)
        : null

    let realizedPnl: number | null = null
    if (tokensSold > 0n && tokensReceived > 0n && spentGross > 0n) {
      const costBasis =
        (Number(tokensSold) / Number(tokensReceived)) * Number(spentGross)
      realizedPnl = (Number(quoteReceived) - costBasis) / 1e18
    }

    const priceState = getPriceState(id)
    let spotPrice: number | null =
      priceState?.spotPrice ?? project.lastSpotPrice ?? null
    if (spotPrice === null) {
      const lastTrade = db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.projectId, id))
        .orderBy(desc(schema.trades.blockNumber))
        .limit(1)
        .get()
      spotPrice = lastTrade?.priceQuotePerToken || null
    }

    const unrealizedPnl =
      spotPrice !== null && remainingTokens > 0n
        ? (Number(remainingTokens) * spotPrice - Number(remainingCostGross)) /
          1e18
        : null

    const recentTrades = db
      .select()
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.projectId, id),
          sql`lower(${schema.trades.trader}) = ${normalizedLower}`,
        ),
      )
      .orderBy(desc(schema.trades.blockNumber))
      .limit(limit)
      .all()

    return {
      projectId: id,
      address: normalizedAddress,
      balance: balanceRow?.balance || '0',
      cost: {
        spentQuoteGross: spentGross.toString(),
        spentQuoteNet: spentNet.toString(),
        taxPaid: taxPaid.toString(),
        tokensReceived: tokensReceived.toString(),
        tokensSold: tokensSold.toString(),
        quoteReceived: quoteReceived.toString(),
        remainingTokens: remainingTokens.toString(),
        remainingCostGross: remainingCostGross.toString(),
        remainingCostNet: remainingCostNet.toString(),
        avgCost: cost?.avgCost ?? null,
        avgCostGross: cost?.avgCostGross ?? null,
        avgCostOpen,
        avgCostOpenGross,
        realizedPnl,
        unrealizedPnl,
        markPrice: spotPrice,
      },
      recentTrades,
    }
  })

  // GET /projects/:id/diagnostics/reconcile - Compare raw vs filtered holders and tax inflows
  fastify.get<{
    Params: { id: string }
    Querystring: { limit?: string }
  }>('/projects/:id/diagnostics/reconcile', async (request, reply) => {
    const { id } = request.params
    const limit = parseInt(request.query.limit || '20', 10)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    const balanceRows = db
      .select()
      .from(schema.tokenBalances)
      .where(eq(schema.tokenBalances.projectId, id))
      .all()

    const positiveBalances = balanceRows.filter((r) => BigInt(r.balance) > 0n)
    const excludedReasons = buildExcludedAddressReasonMap(
      id,
      project.tokenAddress,
    )

    const rawTop = sortByBalanceDesc(positiveBalances).slice(0, limit)
    const filteredRows = positiveBalances.filter(
      (r) => !excludedReasons.has(r.address.toLowerCase()),
    )
    const filteredTop = sortByBalanceDesc(filteredRows).slice(0, limit)

    const excludedWithBalances = positiveBalances
      .filter((r) => excludedReasons.has(r.address.toLowerCase()))
      .map((r) => ({
        address: r.address,
        balance: r.balance,
        reason: excludedReasons.get(r.address.toLowerCase()) || 'excluded',
      }))
    const excludedTop = sortByBalanceDesc(excludedWithBalances).slice(0, limit)

    const inflows = db
      .select()
      .from(schema.taxInflows)
      .where(eq(schema.taxInflows.projectId, id))
      .all()
    const taxByToken = new Map<
      string,
      { token: string; totalAmount: bigint; inflowCount: number }
    >()
    for (const inflow of inflows) {
      if (project.graduatedAt !== null && inflow.ts > project.graduatedAt)
        continue
      const token = inflow.token.toLowerCase()
      const current = taxByToken.get(token) || {
        token,
        totalAmount: 0n,
        inflowCount: 0,
      }
      current.totalAmount += BigInt(inflow.amount)
      current.inflowCount += 1
      taxByToken.set(token, current)
    }

    const taxBreakdown = [...taxByToken.values()]
      .sort((a, b) =>
        b.totalAmount > a.totalAmount
          ? 1
          : b.totalAmount < a.totalAmount
            ? -1
            : 0,
      )
      .map((x) => ({
        token: x.token,
        totalAmount: x.totalAmount.toString(),
        inflowCount: x.inflowCount,
      }))

    const indexerState = db
      .select()
      .from(schema.indexerState)
      .where(eq(schema.indexerState.projectId, id))
      .get()

    return {
      projectId: id,
      tokenAddress: project.tokenAddress,
      taxRecipient: project.taxRecipient,
      holders: {
        limit,
        rawTop,
        filteredTop,
        excludedTop,
        excludedCount: excludedWithBalances.length,
      },
      tax: {
        summary: computeTaxSummary(
          id,
          project.tokenAddress,
          project.graduatedAt ?? null,
        ),
        breakdownByToken: taxBreakdown,
      },
      indexer: {
        lastProcessedBlock: indexerState?.lastProcessedBlock ?? null,
        lastProcessedTs: indexerState?.lastProcessedTs ?? null,
        transferLogFailures: {
          token: getTransferLogFailureStat(project.tokenAddress as Address),
          virtual: getTransferLogFailureStat(VIRTUAL_ADDRESS as Address),
        },
      },
    }
  })

  // GET /projects/:id/large-orders - Large buy orders above a threshold
  fastify.get<{
    Params: { id: string }
    Querystring: { threshold?: string; limit?: string }
  }>('/projects/:id/large-orders', async (request, reply) => {
    const { id } = request.params
    // Default threshold: 100 VIRTUAL (in wei)
    const thresholdWei = request.query.threshold
      ? BigInt(request.query.threshold)
      : BigInt('100000000000000000000') // 100V
    const limit = parseInt(request.query.limit || '50', 10)

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    // Fetch BUY trades
    const allBuys = db
      .select()
      .from(schema.trades)
      .where(
        and(eq(schema.trades.projectId, id), eq(schema.trades.side, 'BUY')),
      )
      .orderBy(desc(schema.trades.blockNumber))
      .all()

    // Filter by gross amount >= threshold
    const largeOrders = allBuys
      .filter((t) => {
        const gross = t.quoteInGross
          ? BigInt(t.quoteInGross)
          : t.quoteIn
            ? BigInt(t.quoteIn)
            : 0n
        return gross >= thresholdWei
      })
      .slice(0, limit)
      .map((t) => {
        const grossWei = t.quoteInGross
          ? BigInt(t.quoteInGross)
          : t.quoteIn
            ? BigInt(t.quoteIn)
            : 0n
        const netWei = t.quoteIn ? BigInt(t.quoteIn) : 0n
        const taxWei = grossWei > netWei ? grossWei - netWei : 0n
        const tokenOutWei = t.tokenOut ? BigInt(t.tokenOut) : 0n
        const taxRate = grossWei > 0n ? Number(taxWei) / Number(grossWei) : 0

        return {
          txHash: t.txHash,
          blockNumber: t.blockNumber,
          ts: t.ts,
          trader: t.trader,
          venue: t.venue,
          quoteInGross: grossWei.toString(),
          quoteInNet: netWei.toString(),
          taxPaid: taxWei.toString(),
          taxRate,
          tokenOut: t.tokenOut,
          priceNet: t.priceQuotePerToken,
          priceGross:
            tokenOutWei > 0n ? Number(grossWei) / Number(tokenOutWei) : null,
        }
      })

    return {
      threshold: thresholdWei.toString(),
      count: largeOrders.length,
      orders: largeOrders,
    }
  })

  // GET /projects/:id/costs/summary
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/costs/summary',
    async (request, reply) => {
      const { id } = request.params

      const project = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get()

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      return computeCostSummary(id)
    },
  )

  // GET /projects/:id/tax/summary
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/tax/summary',
    async (request, reply) => {
      const { id } = request.params

      const project = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get()

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      return computeTaxSummary(
        id,
        project.tokenAddress,
        project.graduatedAt ?? null,
      )
    },
  )
}

