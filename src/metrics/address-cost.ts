import { db, schema } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import type { Trade } from '../types.js'

/**
 * Update address cost tracking for a single trade.
 * Tracks both NET spend (after tax) and GROSS spend (user's actual outlay).
 *
 * - spentQuoteGross (legacy name): NET VIRTUAL that reached the market
 * - spentQuoteGrossActual: GROSS VIRTUAL the user actually paid (before tax)
 * - avgCost: NET cost per token (market execution price)
 * - avgCostGross: GROSS cost per token (user's actual cost including tax)
 */
export function updateAddressCost(trade: Trade): void {
  const { projectId, trader, side, blockNumber } = trade

  // Get existing record or create new
  const existing = db
    .select()
    .from(schema.addressCosts)
    .where(
      and(
        eq(schema.addressCosts.projectId, projectId),
        eq(schema.addressCosts.address, trader),
      ),
    )
    .get()

  let spentQuoteNet = BigInt(existing?.spentQuoteGross || '0')
  let spentQuoteGrossActual = BigInt(existing?.spentQuoteGrossActual || '0')
  let tokensReceived = BigInt(existing?.tokensReceived || '0')
  let tokensSold = BigInt(existing?.tokensSold || '0')
  let quoteReceived = BigInt(existing?.quoteReceived || '0')

  if (side === 'BUY' && trade.quoteIn && trade.tokenOut) {
    spentQuoteNet += BigInt(trade.quoteIn)
    // Use gross if available, otherwise fall back to net
    const gross = trade.quoteInGross ? BigInt(trade.quoteInGross) : BigInt(trade.quoteIn)
    spentQuoteGrossActual += gross
    tokensReceived += BigInt(trade.tokenOut)
  } else if (side === 'SELL' && trade.tokenIn && trade.quoteOut) {
    tokensSold += BigInt(trade.tokenIn)
    quoteReceived += BigInt(trade.quoteOut)
  }

  // NET avg cost (market execution price per token)
  const avgCost =
    tokensReceived > 0n
      ? Number(spentQuoteNet) / Number(tokensReceived)
      : null

  // GROSS avg cost (user's actual outlay per token, including tax)
  const avgCostGross =
    tokensReceived > 0n
      ? Number(spentQuoteGrossActual) / Number(tokensReceived)
      : null

  if (existing) {
    db.update(schema.addressCosts)
      .set({
        spentQuoteGross: spentQuoteNet.toString(),
        spentQuoteGrossActual: spentQuoteGrossActual.toString(),
        tokensReceived: tokensReceived.toString(),
        tokensSold: tokensSold.toString(),
        quoteReceived: quoteReceived.toString(),
        avgCost,
        avgCostGross,
        lastUpdatedBlock: blockNumber,
      })
      .where(
        and(
          eq(schema.addressCosts.projectId, projectId),
          eq(schema.addressCosts.address, trader),
        ),
      )
      .run()
  } else {
    db.insert(schema.addressCosts)
      .values({
        projectId,
        address: trader,
        spentQuoteGross: spentQuoteNet.toString(),
        spentQuoteGrossActual: spentQuoteGrossActual.toString(),
        tokensReceived: tokensReceived.toString(),
        tokensSold: tokensSold.toString(),
        quoteReceived: quoteReceived.toString(),
        avgCost,
        avgCostGross,
        lastUpdatedBlock: blockNumber,
      })
      .run()
  }
}

/**
 * Batch update address costs for multiple trades.
 */
export function updateAddressCosts(trades: Trade[]): void {
  for (const trade of trades) {
    updateAddressCost(trade)
  }
}
