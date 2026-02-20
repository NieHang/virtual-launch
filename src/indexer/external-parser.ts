import { type Address, type Log, decodeEventLog, getAddress } from 'viem'
import { UNISWAP_V2_PAIR_ABI, VIRTUAL_ADDRESS } from '../chain/constants.js'
import { getReserves } from './graduation.js'
import type { Trade, Venue } from '../types.js'

/**
 * Parse Uniswap V2 Swap events into standardized Trade records.
 */
export function parseSwapEvents(
  swapLogs: Log[],
  pairAddress: Address,
  token0: Address,
  token1: Address,
  tokenAddress: Address,
  projectId: string,
  blockTimestamp: number,
): Trade[] {
  const trades: Trade[] = []
  const normalizedToken = getAddress(tokenAddress).toLowerCase()
  const normalizedVirtual = getAddress(VIRTUAL_ADDRESS).toLowerCase()

  // Determine which position the project token and VIRTUAL occupy
  const token0Lower = getAddress(token0).toLowerCase()
  const isToken0ProjectToken = token0Lower === normalizedToken

  for (const log of swapLogs) {
    try {
      if (!log.data || !log.blockNumber || !log.transactionHash) continue

      const decoded = decodeEventLog({
        abi: UNISWAP_V2_PAIR_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      })

      if (decoded.eventName !== 'Swap') continue

      const { sender, amount0In, amount1In, amount0Out, amount1Out, to } =
        decoded.args as {
          sender: Address
          amount0In: bigint
          amount1In: bigint
          amount0Out: bigint
          amount1Out: bigint
          to: Address
        }

      // Determine BUY/SELL relative to the project token
      let side: 'BUY' | 'SELL'
      let quoteIn: bigint | null = null
      let quoteOut: bigint | null = null
      let tokenIn: bigint | null = null
      let tokenOut: bigint | null = null

      if (isToken0ProjectToken) {
        // token0 = project token, token1 = VIRTUAL
        if (amount1In > 0n && amount0Out > 0n) {
          // VIRTUAL in, token out = BUY
          side = 'BUY'
          quoteIn = amount1In
          tokenOut = amount0Out
        } else if (amount0In > 0n && amount1Out > 0n) {
          // Token in, VIRTUAL out = SELL
          side = 'SELL'
          tokenIn = amount0In
          quoteOut = amount1Out
        } else {
          continue
        }
      } else {
        // token0 = VIRTUAL, token1 = project token
        if (amount0In > 0n && amount1Out > 0n) {
          // VIRTUAL in, token out = BUY
          side = 'BUY'
          quoteIn = amount0In
          tokenOut = amount1Out
        } else if (amount1In > 0n && amount0Out > 0n) {
          // Token in, VIRTUAL out = SELL
          side = 'SELL'
          tokenIn = amount1In
          quoteOut = amount0Out
        } else {
          continue
        }
      }

      // Calculate price
      let price: number | null = null
      if (side === 'BUY' && quoteIn && tokenOut && tokenOut > 0n) {
        price = Number(quoteIn) / Number(tokenOut)
      } else if (side === 'SELL' && quoteOut && tokenIn && tokenIn > 0n) {
        price = Number(quoteOut) / Number(tokenIn)
      }

      trades.push({
        projectId,
        venue: 'EXTERNAL' as Venue,
        marketAddress: getAddress(pairAddress),
        txHash: log.transactionHash,
        logIndex:
          typeof log.logIndex === 'number'
            ? log.logIndex
            : Number(log.logIndex),
        blockNumber: Number(log.blockNumber),
        ts: blockTimestamp,
        trader: getAddress(to), // MVP: use 'to' address of swap
        side,
        quoteIn: quoteIn?.toString() || null,
        quoteInGross: quoteIn?.toString() || null, // External: gross = net (tax applied on token side)
        quoteOut: quoteOut?.toString() || null,
        tokenIn: tokenIn?.toString() || null,
        tokenOut: tokenOut?.toString() || null,
        priceQuotePerToken: price,
      })
    } catch {
      // Skip unparseable logs
    }
  }

  return trades
}

/**
 * Get spot price from Uniswap V2 pair reserves.
 * Returns price in VIRTUAL per token.
 */
export async function getExternalSpotPrice(
  pairAddress: Address,
  token0: Address,
  tokenAddress: Address,
): Promise<number | null> {
  const reserves = await getReserves(pairAddress)
  if (!reserves || reserves.reserve0 === 0n || reserves.reserve1 === 0n) {
    return null
  }

  const isToken0 =
    getAddress(token0).toLowerCase() === getAddress(tokenAddress).toLowerCase()

  if (isToken0) {
    // token0 = project token, token1 = VIRTUAL
    // price = reserve1 / reserve0
    return Number(reserves.reserve1) / Number(reserves.reserve0)
  } else {
    // token0 = VIRTUAL, token1 = project token
    // price = reserve0 / reserve1
    return Number(reserves.reserve0) / Number(reserves.reserve1)
  }
}

