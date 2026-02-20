import { db, schema } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { VIRTUAL_ADDRESS } from '../chain/constants.js'
import type { TaxSummary } from '../types.js'

/**
 * Compute actual tax accumulation from tax_inflows table.
 */
export function computeTaxSummary(
  projectId: string,
  tokenAddress: string,
  cutoffTs: number | null = null,
): TaxSummary {
  const rows = db
    .select()
    .from(schema.taxInflows)
    .where(eq(schema.taxInflows.projectId, projectId))
    .all()

  let actualVirtual = 0n
  let actualToken = 0n

  for (const row of rows) {
    if (cutoffTs !== null && row.ts > cutoffTs) continue
    const amount = BigInt(row.amount)
    if (row.token.toLowerCase() === VIRTUAL_ADDRESS.toLowerCase()) {
      actualVirtual += amount
    } else if (row.token.toLowerCase() === tokenAddress.toLowerCase()) {
      actualToken += amount
    }
  }

  // Estimated tax: sum from trades * estimated tax rate
  // This is a backup calculation when actual inflows are incomplete
  const trades = db
    .select()
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.projectId, projectId),
        eq(schema.trades.side, 'BUY'),
      ),
    )
    .all()

  let estimatedVirtual = 0n
  for (const trade of trades) {
    if (cutoffTs !== null && trade.ts > cutoffTs) continue
    if (trade.quoteIn) {
      // Assume ~1% tax as baseline estimate if we can't read from contract
      const taxAmount = BigInt(trade.quoteIn) / 100n
      estimatedVirtual += taxAmount
    }
  }

  return {
    actualVirtual: actualVirtual.toString(),
    actualToken: actualToken.toString(),
    estimatedVirtual: estimatedVirtual.toString(),
    estimatedToken: '0', // Token tax estimation not implemented
  }
}

export interface BuybackTaxProgress {
  graduationTaxVirtual: string
  buybackSpentVirtual: string
  remainingTaxVirtual: string
}

/**
 * Compute buyback tax progress after graduation:
 * remaining = tax collected by graduation - tax spent by buyback wallet.
 */
export function computeBuybackTaxProgress(
  projectId: string,
  taxRecipient: string | null,
  buybackExecutorAddress: string | null,
  graduatedAt: number | null,
): BuybackTaxProgress | null {
  if (!taxRecipient || !graduatedAt) return null

  const taxRecipientLower = taxRecipient.toLowerCase()
  const buybackExecutorLower = buybackExecutorAddress
    ? buybackExecutorAddress.toLowerCase()
    : taxRecipientLower
  const virtualLower = VIRTUAL_ADDRESS.toLowerCase()

  const inflows = db
    .select()
    .from(schema.taxInflows)
    .where(eq(schema.taxInflows.projectId, projectId))
    .all()

  let graduationTaxVirtual = 0n
  for (const inflow of inflows) {
    if (inflow.ts > graduatedAt) continue
    if (inflow.token.toLowerCase() !== virtualLower) continue
    graduationTaxVirtual += BigInt(inflow.amount)
  }

  const trades = db
    .select()
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.projectId, projectId),
        eq(schema.trades.side, 'BUY'),
      ),
    )
    .all()

  let buybackSpentVirtual = 0n
  for (const trade of trades) {
    if (trade.ts < graduatedAt) continue
    // Prefer dedicated buyback executor; fallback to tax recipient for compatibility.
    if (trade.trader.toLowerCase() !== buybackExecutorLower) continue
    const spent = trade.quoteInGross || trade.quoteIn || '0'
    buybackSpentVirtual += BigInt(spent)
  }

  const remainingTaxVirtual =
    graduationTaxVirtual > buybackSpentVirtual
      ? graduationTaxVirtual - buybackSpentVirtual
      : 0n
  return {
    graduationTaxVirtual: graduationTaxVirtual.toString(),
    buybackSpentVirtual: buybackSpentVirtual.toString(),
    remainingTaxVirtual: remainingTaxVirtual.toString(),
  }
}
