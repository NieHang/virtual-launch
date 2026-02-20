import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import type { CostSummary } from '../types.js'

/**
 * Compute global cost summary for a project.
 * Open-position basis (current holders with remaining position > 0):
 * - Weighted average: total remaining cost / total remaining tokens
 * - Equal-weight average: mean of per-address open avg costs
 * - Percentiles: P50, P75, P90 of per-address open avg costs
 */
export function computeCostSummary(projectId: string): CostSummary {
  const costRows = db
    .select()
    .from(schema.addressCosts)
    .where(eq(schema.addressCosts.projectId, projectId))
    .all()

  if (costRows.length === 0) {
    return {
      weightedAvgCost: null,
      equalWeightAvgCost: null,
      p50: null,
      p75: null,
      p90: null,
      addressCount: 0,
    }
  }

  const balanceRows = db
    .select()
    .from(schema.tokenBalances)
    .where(eq(schema.tokenBalances.projectId, projectId))
    .all()
  const balanceMap = new Map<string, bigint>()
  for (const b of balanceRows) {
    balanceMap.set(b.address.toLowerCase(), BigInt(b.balance))
  }

  let totalRemainingCostGross = 0n
  let totalRemainingTokens = 0n
  const openCosts: number[] = []

  for (const row of costRows) {
    const balance = balanceMap.get(row.address.toLowerCase()) || 0n
    if (balance <= 0n) continue

    const spentGrossActual = BigInt(row.spentQuoteGrossActual || row.spentQuoteGross)
    const tokensReceived = BigInt(row.tokensReceived)
    const tokensSold = BigInt(row.tokensSold)
    if (tokensReceived <= 0n) continue

    const remainingTokens =
      tokensReceived > tokensSold ? tokensReceived - tokensSold : 0n
    if (remainingTokens <= 0n) continue

    const soldCostGross =
      tokensSold > 0n ? (spentGrossActual * tokensSold) / tokensReceived : 0n
    const remainingCostGross =
      spentGrossActual > soldCostGross ? spentGrossActual - soldCostGross : 0n
    if (remainingCostGross <= 0n) continue

    totalRemainingCostGross += remainingCostGross
    totalRemainingTokens += remainingTokens

    const openAvgCostGross = Number(remainingCostGross) / Number(remainingTokens)
    if (Number.isFinite(openAvgCostGross) && openAvgCostGross > 0) {
      openCosts.push(openAvgCostGross)
    }
  }

  if (openCosts.length === 0 || totalRemainingTokens <= 0n) {
    return {
      weightedAvgCost: null,
      equalWeightAvgCost: null,
      p50: null,
      p75: null,
      p90: null,
      addressCount: 0,
    }
  }

  // Weighted average (open positions only)
  const weightedAvgCost =
    totalRemainingTokens > 0n
      ? Number(totalRemainingCostGross) / Number(totalRemainingTokens)
      : null

  // Equal-weight average (open positions only)
  const equalWeightAvgCost =
    openCosts.length > 0
      ? openCosts.reduce((a, b) => a + b, 0) / openCosts.length
      : null

  // Percentiles
  openCosts.sort((a, b) => a - b)

  const percentile = (arr: number[], p: number): number | null => {
    if (arr.length === 0) return null
    const idx = Math.ceil((p / 100) * arr.length) - 1
    return arr[Math.max(0, idx)]
  }

  return {
    weightedAvgCost,
    equalWeightAvgCost,
    p50: percentile(openCosts, 50),
    p75: percentile(openCosts, 75),
    p90: percentile(openCosts, 90),
    addressCount: openCosts.length,
  }
}
