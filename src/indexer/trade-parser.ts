import { type Address, getAddress } from 'viem'
import { VIRTUAL_ADDRESS } from '../chain/constants.js'
import type { ParsedTransfer, Trade, Side, Venue } from '../types.js'
import {
  type TxTransferGroup,
  hasLaunchPathTransfers,
  inferLaunchPathBuyQuote,
  inferLaunchPathSellQuoteOut,
} from './launch-path-parser.js'

interface TradeCandidate {
  txHash: string
  blockNumber: number
  trader: string
  side: Side
  quoteIn: bigint | null       // NET (after tax)
  quoteInGross: bigint | null  // GROSS (user's actual outlay, before tax)
  quoteOut: bigint | null
  tokenIn: bigint | null
  tokenOut: bigint | null
  priceQuotePerToken: number | null
  minLogIndex: number
}

/**
 * Reconstruct trades from Transfer events grouped by transaction.
 *
 * For each tx involving the market address:
 * 1. Compute net flows of VIRTUAL and TOKEN relative to the market
 * 2. Classify as BUY or SELL based on flow direction
 * 3. Calculate price from quote/token amounts
 */
export function reconstructTrades(
  tokenTransfers: ParsedTransfer[],
  virtualTransfers: ParsedTransfer[],
  marketAddress: Address,
  tokenAddress: Address,
  projectId: string,
  venue: Venue,
  blockTimestamp: number,
): Trade[] {
  const normalizedMarket = getAddress(marketAddress).toLowerCase()
  const normalizedToken = getAddress(tokenAddress).toLowerCase()
  const normalizedVirtual = getAddress(VIRTUAL_ADDRESS).toLowerCase()

  // Group all transfers by txHash
  const txGroups = new Map<string, TxTransferGroup>()

  for (const t of tokenTransfers) {
    if (
      t.from.toLowerCase() === normalizedMarket ||
      t.to.toLowerCase() === normalizedMarket
    ) {
      if (!txGroups.has(t.txHash)) {
        txGroups.set(t.txHash, { token: [], virtual: [] })
      }
      txGroups.get(t.txHash)!.token.push(t)
    }
  }

  for (const v of virtualTransfers) {
    const group = txGroups.get(v.txHash)
    // If this tx already has market-related token transfers, include ALL VIRTUAL
    // transfers from this tx to capture router/fee-flow style internals.
    if (group) {
      group.virtual.push(v)
      continue
    }
    // Otherwise, only create group when VIRTUAL transfer involves market.
    if (
      v.from.toLowerCase() === normalizedMarket ||
      v.to.toLowerCase() === normalizedMarket
    ) {
      txGroups.set(v.txHash, { token: [], virtual: [v] })
    }
  }

  const trades: Trade[] = []

  for (const [txHash, group] of txGroups) {
    // Compute net VIRTUAL flow relative to market
    // positive = market received VIRTUAL, negative = market sent VIRTUAL
    let deltaVirtual = 0n
    for (const v of group.virtual) {
      if (v.to.toLowerCase() === normalizedMarket) {
        deltaVirtual += v.value
      }
      if (v.from.toLowerCase() === normalizedMarket) {
        deltaVirtual -= v.value
      }
    }

    // Compute net TOKEN flow relative to market
    let deltaToken = 0n
    for (const t of group.token) {
      if (t.to.toLowerCase() === normalizedMarket) {
        deltaToken += t.value
      }
      if (t.from.toLowerCase() === normalizedMarket) {
        deltaToken -= t.value
      }
    }

    // Skip if no meaningful flow
    if (deltaVirtual === 0n && deltaToken === 0n) continue

    let candidate: TradeCandidate | null = null
    const allLogs = [...group.token, ...group.virtual]
    const minLogIndex = Math.min(...allLogs.map((l) => l.logIndex))
    const blockNumber = allLogs[0]?.blockNumber || 0

    // Determine trader: for BUY, the sender of VIRTUAL; for SELL, the sender of TOKEN
    let trader = ''

    if (deltaVirtual > 0n && deltaToken < 0n) {
      // BUY: market received VIRTUAL, market sent token
      const quoteInNet = deltaVirtual  // NET retained by market after outflows
      const tokenOutTotal = -deltaToken

      // GROSS = total VIRTUAL sent TO the market in this tx (before tax deduction)
      // This captures the user's actual outlay (e.g., 1000V even if 990V went to tax)
      let quoteInGross = 0n
      for (const v of group.virtual) {
        if (v.to.toLowerCase() === normalizedMarket) {
          quoteInGross += v.value
        }
      }
      // If gross < net (shouldn't happen), fall back to net
      if (quoteInGross < quoteInNet) quoteInGross = quoteInNet

      // Trader is whoever sent VIRTUAL to the market (or to the router that forwarded it)
      // MVP: use the first token Transfer "to" address that isn't the market
      const tokenRecipient = group.token.find(
        (t) => t.from.toLowerCase() === normalizedMarket,
      )
      trader = tokenRecipient?.to || ''

      // If still empty, try VIRTUAL sender
      if (!trader) {
        const virtualSender = group.virtual.find(
          (v) => v.to.toLowerCase() === normalizedMarket,
        )
        trader = virtualSender?.from || 'unknown'
      }

      // Refine amounts to trader-specific net flows when possible.
      let tokenOut = tokenOutTotal
      let quoteInGrossTrader = quoteInGross
      if (trader && trader !== 'unknown') {
        const traderLower = trader.toLowerCase()
        const tokenToTrader = group.token
          .filter(
            (t) =>
              t.from.toLowerCase() === normalizedMarket &&
              t.to.toLowerCase() === traderLower,
          )
          .reduce((sum, t) => sum + t.value, 0n)
        if (tokenToTrader > 0n) tokenOut = tokenToTrader

        const virtualFromTraderToMarket = group.virtual
          .filter(
            (v) =>
              v.to.toLowerCase() === normalizedMarket &&
              v.from.toLowerCase() === traderLower,
          )
          .reduce((sum, v) => sum + v.value, 0n)
        // Gross user outlay should include all VIRTUAL the trader sent in this tx
        // (market leg + tax/fee side legs), not just trader->market transfers.
        const virtualFromTraderTotal = group.virtual
          .filter((v) => v.from.toLowerCase() === traderLower)
          .reduce((sum, v) => sum + v.value, 0n)
        if (virtualFromTraderTotal > 0n) {
          quoteInGrossTrader = virtualFromTraderTotal
        } else if (virtualFromTraderToMarket > 0n) {
          quoteInGrossTrader = virtualFromTraderToMarket
        }
      }

      // Price based on NET amount (actual tokens-per-VIRTUAL that reached the curve)
      if (tokenOut <= 0n) continue
      const price = Number(quoteInNet) / Number(tokenOut)

      candidate = {
        txHash,
        blockNumber,
        trader: getAddress(trader),
        side: 'BUY',
        quoteIn: quoteInNet,
        quoteInGross: quoteInGrossTrader,
        quoteOut: null,
        tokenIn: null,
        tokenOut: tokenOut,
        priceQuotePerToken: price,
        minLogIndex,
      }
    } else if (deltaToken > 0n && deltaVirtual < 0n) {
      // SELL: market received token, market sent VIRTUAL
      let tokenIn = deltaToken
      let quoteOut = -deltaVirtual

      // Trader is whoever sent TOKEN to the market
      const tokenSender = group.token.find(
        (t) => t.to.toLowerCase() === normalizedMarket,
      )
      trader = tokenSender?.from || ''

      if (!trader) {
        const virtualRecipient = group.virtual.find(
          (v) => v.from.toLowerCase() === normalizedMarket,
        )
        trader = virtualRecipient?.to || 'unknown'
      }

      // Refine to trader-specific amounts to avoid counting tax/platform payouts
      // as trader proceeds.
      if (trader && trader !== 'unknown') {
        const traderLower = trader.toLowerCase()
        const tokenFromTrader = group.token
          .filter(
            (t) =>
              t.to.toLowerCase() === normalizedMarket &&
              t.from.toLowerCase() === traderLower,
          )
          .reduce((sum, t) => sum + t.value, 0n)
        if (tokenFromTrader > 0n) tokenIn = tokenFromTrader

        const virtualToTrader = group.virtual
          .filter(
            (v) =>
              v.from.toLowerCase() === normalizedMarket &&
              v.to.toLowerCase() === traderLower,
          )
          .reduce((sum, v) => sum + v.value, 0n)
        if (virtualToTrader > 0n) quoteOut = virtualToTrader
      }

      if (tokenIn <= 0n || quoteOut <= 0n) continue
      const price = Number(quoteOut) / Number(tokenIn)

      candidate = {
        txHash,
        blockNumber,
        trader: getAddress(trader),
        side: 'SELL',
        quoteIn: null,
        quoteInGross: null,
        quoteOut: quoteOut,
        tokenIn: tokenIn,
        tokenOut: null,
        priceQuotePerToken: price,
        minLogIndex,
      }
    } else if (deltaToken > 0n && hasLaunchPathTransfers(group)) {
      // Launch-specific SELL fallback:
      // market received TOKEN, but VIRTUAL payout is routed via launch path contracts.
      const tokenSender = group.token.find(
        (t) => t.to.toLowerCase() === normalizedMarket,
      )
      trader = tokenSender?.from || ''
      if (!trader) continue

      const traderLower = trader.toLowerCase()
      const tokenIn = group.token
        .filter(
          (t) =>
            t.to.toLowerCase() === normalizedMarket &&
            t.from.toLowerCase() === traderLower,
        )
        .reduce((sum, t) => sum + t.value, 0n)
      if (tokenIn <= 0n) continue

      const quoteOut = inferLaunchPathSellQuoteOut(group, traderLower)
      if (quoteOut <= 0n) continue

      const price = Number(quoteOut) / Number(tokenIn)
      candidate = {
        txHash,
        blockNumber,
        trader: getAddress(trader),
        side: 'SELL',
        quoteIn: null,
        quoteInGross: null,
        quoteOut,
        tokenIn,
        tokenOut: null,
        priceQuotePerToken: price,
        minLogIndex,
      }
    } else if (deltaToken < 0n) {
      // Router-like BUY fallback:
      // market sent TOKEN, but VIRTUAL may not flow directly to market.
      const tokenRecipient = group.token.find(
        (t) => t.from.toLowerCase() === normalizedMarket,
      )
      trader = tokenRecipient?.to || ''
      if (!trader) continue

      const traderLower = trader.toLowerCase()
      const tokenOut = group.token
        .filter(
          (t) =>
            t.from.toLowerCase() === normalizedMarket &&
            t.to.toLowerCase() === traderLower,
        )
        .reduce((sum, t) => sum + t.value, 0n)
      if (tokenOut <= 0n) continue

      // Prefer normal router-like inference first.
      let quoteInGross = group.virtual
        .filter((v) => v.from.toLowerCase() === traderLower)
        .reduce((sum, v) => sum + v.value, 0n)
      let quoteInNetFallback = quoteInGross

      // If no generic trader-originating VIRTUAL is present, try launch-specific
      // path reconstruction from known protocol addresses.
      if (quoteInGross <= 0n && hasLaunchPathTransfers(group)) {
        const inferred = inferLaunchPathBuyQuote(group, traderLower)
        quoteInGross = inferred.gross
        quoteInNetFallback = inferred.net
      }
      if (quoteInGross <= 0n) continue

      let quoteInNet = deltaVirtual > 0n ? deltaVirtual : quoteInNetFallback
      if (quoteInNet <= 0n) quoteInNet = quoteInGross
      if (quoteInNet > quoteInGross) quoteInNet = quoteInGross
      const price = Number(quoteInNet) / Number(tokenOut)

      candidate = {
        txHash,
        blockNumber,
        trader: getAddress(trader),
        side: 'BUY',
        quoteIn: quoteInNet,
        quoteInGross,
        quoteOut: null,
        tokenIn: null,
        tokenOut,
        priceQuotePerToken: price,
        minLogIndex,
      }
    }

    if (candidate) {
      trades.push({
        projectId,
        venue,
        marketAddress: getAddress(marketAddress),
        txHash: candidate.txHash,
        logIndex: candidate.minLogIndex,
        blockNumber: candidate.blockNumber,
        ts: blockTimestamp,
        trader: candidate.trader,
        side: candidate.side,
        quoteIn: candidate.quoteIn?.toString() || null,
        quoteInGross: candidate.quoteInGross?.toString() || null,
        quoteOut: candidate.quoteOut?.toString() || null,
        tokenIn: candidate.tokenIn?.toString() || null,
        tokenOut: candidate.tokenOut?.toString() || null,
        priceQuotePerToken: candidate.priceQuotePerToken,
      })
    }
  }

  return trades
}

