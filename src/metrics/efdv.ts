import { type Address } from 'viem'
import { getClient } from '../chain/client.js'
import { TOKEN_ABI } from '../chain/constants.js'
import { readBuyTaxBps, getDecayTaxRate } from '../indexer/tax-tracker.js'

/**
 * Read total supply from the token contract.
 * Falls back to 1 billion (1e9 * 1e18) if not readable.
 */
export async function readTotalSupply(tokenAddress: Address): Promise<bigint> {
  const client = getClient()
  try {
    const supply = (await client.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: 'totalSupply',
    })) as bigint
    return supply
  } catch {
    // Default assumption: 1 billion tokens with 18 decimals
    return BigInt('1000000000000000000000000000')
  }
}

/**
 * Compute FDV and EFDV.
 *
 * FDV = spot_price * total_supply
 * EFDV = FDV / (1 - buy_tax_rate)
 *
 * @param spotPrice - Current price in VIRTUAL per token (already divided by 1e18)
 * @param totalSupply - Total supply in wei
 * @param buyTaxRate - Tax rate as a decimal (e.g., 0.01 for 1%)
 */
export function computeFdvEfdv(
  spotPrice: number,
  totalSupply: bigint,
  buyTaxRate: number,
  prebuyRatio = 0,
): { fdv: number; efdv: number } {
  // totalSupply is in wei (18 decimals), price is in VIRTUAL per token
  const supplyFloat = Number(totalSupply) / 1e18
  const prebuyMultiplier = derivePrebuyMultiplier(prebuyRatio)
  const fdv = spotPrice * supplyFloat * prebuyMultiplier

  // EFDV accounts for the fact that market price includes tax
  const efdv = buyTaxRate < 1 ? fdv / (1 - buyTaxRate) : fdv

  return { fdv, efdv }
}

export interface LayeredEfdvRow {
  taxRate: number
  impliedFdv: number
  impliedEfdv: number
  breakevenMultiple: number
}

export interface LayeredEfdvResult {
  basePrice: number
  priceSource: 'LAUNCH_CURVE_DERIVED' | 'LIVE_SPOT'
  taxModel: 'LINEAR_99_TO_1'
  prebuyRatio: number
  prebuyMultiplier: number
  layers: LayeredEfdvRow[]
}

export function normalizePrebuyRatio(prebuyRatio: number): number {
  if (!Number.isFinite(prebuyRatio)) return 0
  if (prebuyRatio <= 0) return 0
  if (prebuyRatio >= 0.99) return 0.99
  return prebuyRatio
}

export function derivePrebuyMultiplier(prebuyRatio: number): number {
  const normalizedRatio = normalizePrebuyRatio(prebuyRatio)
  return normalizedRatio < 1 ? 1 / (1 - normalizedRatio) : 1
}

/**
 * Prelaunch base price from launch tokenomics assumptions.
 * Current system already uses 42,000 V as internal graduation target; we
 * derive a baseline launch price by distributing that quote notional over supply.
 */
export function deriveLaunchCurveBasePrice(totalSupply: bigint): number {
  const supply = Number(totalSupply) / 1e18
  if (!Number.isFinite(supply) || supply <= 0) return 0
  const graduationTargetVirtual = 42_000
  return graduationTargetVirtual / supply
}

export function buildDecayTaxLayers(): number[] {
  const rows: number[] = []
  for (let bps = 9900; bps >= 100; bps -= 100) {
    rows.push(bps / 10000)
  }
  return rows
}

export function computeLayeredEfdv(
  totalSupply: bigint,
  basePrice: number,
  taxRates: number[] = buildDecayTaxLayers(),
  priceSource: 'LAUNCH_CURVE_DERIVED' | 'LIVE_SPOT' = 'LAUNCH_CURVE_DERIVED',
  prebuyRatio = 0,
): LayeredEfdvResult {
  const normalizedPrebuyRatio = normalizePrebuyRatio(prebuyRatio)
  const prebuyMultiplier = derivePrebuyMultiplier(normalizedPrebuyRatio)
  const layers = taxRates.map((taxRate) => {
    const { fdv, efdv } = computeFdvEfdv(basePrice, totalSupply, taxRate, normalizedPrebuyRatio)
    return {
      taxRate,
      impliedFdv: fdv,
      impliedEfdv: efdv,
      breakevenMultiple: taxRate < 1 ? 1 / (1 - taxRate) : 1,
    }
  })

  return {
    basePrice,
    priceSource,
    taxModel: 'LINEAR_99_TO_1',
    prebuyRatio: normalizedPrebuyRatio,
    prebuyMultiplier,
    layers,
  }
}

/**
 * Get the current buy tax rate for a token.
 * Tries to read from contract first, falls back to time-decay model.
 */
export async function getCurrentBuyTaxRate(
  tokenAddress: Address,
  firstTradeTs: number | null,
): Promise<number> {
  // Try contract read first
  const bps = await readBuyTaxBps(tokenAddress)
  if (bps !== null) {
    return bps / 10000 // Convert basis points to decimal
  }

  // Fallback: time-decay model
  if (firstTradeTs) {
    const nowTs = Math.floor(Date.now() / 1000)
    return getDecayTaxRate(firstTradeTs, nowTs)
  }

  // Default to 1%
  return 0.01
}

