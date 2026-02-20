import {
  type Log,
  decodeEventLog,
  type Address,
  getAddress,
  formatEther,
} from 'viem'
import { getClient } from './client.js'
import { ERC20_TRANSFER_ABI, TRANSFER_TOPIC } from './constants.js'
import { recordTransferLogFailure } from '../indexer/observability.js'
import type { ParsedTransfer } from '../types.js'

/**
 * Parse raw Transfer logs into structured ParsedTransfer objects.
 */
export function parseTransferLogs(logs: Log[]): ParsedTransfer[] {
  const parsed: ParsedTransfer[] = []

  for (const log of logs) {
    try {
      if (!log.topics[0] || log.topics[0] !== TRANSFER_TOPIC) continue
      if (!log.data || !log.blockNumber || !log.transactionHash) continue

      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      })

      parsed.push({
        address: getAddress(log.address),
        from: getAddress(decoded.args.from),
        to: getAddress(decoded.args.to),
        value: decoded.args.value,
        txHash: log.transactionHash,
        logIndex:
          typeof log.logIndex === 'number'
            ? log.logIndex
            : Number(log.logIndex),
        blockNumber: Number(log.blockNumber),
      })
    } catch {
      // Skip unparseable logs
    }
  }

  return parsed
}

/**
 * Check if an address is a contract (has code).
 */
export async function isContract(address: Address): Promise<boolean> {
  const client = getClient()
  const code = await client.getCode({ address })
  return !!code && code !== '0x'
}

/**
 * Fetch Transfer logs for a given contract within a block range.
 * Auto-splits range on RPC errors (range too wide).
 */
export async function fetchTransferLogs(
  contractAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const client = getClient()

  try {
    return await client.getLogs({
      address: contractAddress,
      event: {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { type: 'address', name: 'from', indexed: true },
          { type: 'address', name: 'to', indexed: true },
          { type: 'uint256', name: 'value', indexed: false },
        ],
      },
      fromBlock,
      toBlock,
    })
  } catch (error: any) {
    const msg = error?.message || ''
    // If range too large, split in half and recurse
    if (
      msg.includes('range') ||
      msg.includes('limit') ||
      msg.includes('too many') ||
      msg.includes('block range') ||
      msg.includes('Log response size exceeded')
    ) {
      if (toBlock - fromBlock <= 1n) {
        // Can't split further: do a few direct retries before giving up.
        for (let i = 0; i < 3; i++) {
          try {
            await sleep(500 * (i + 1))
            return await client.getLogs({
              address: contractAddress,
              event: {
                type: 'event',
                name: 'Transfer',
                inputs: [
                  { type: 'address', name: 'from', indexed: true },
                  { type: 'address', name: 'to', indexed: true },
                  { type: 'uint256', name: 'value', indexed: false },
                ],
              },
              fromBlock,
              toBlock,
            })
          } catch {
            // continue retries
          }
        }

        console.warn(
          `[RPC] getLogs failed after retries for ${contractAddress} blocks ${fromBlock}-${toBlock}`,
        )
        recordTransferLogFailure(contractAddress, fromBlock, toBlock, msg || 'unknown getLogs error')
        return []
      }
      const mid = fromBlock + (toBlock - fromBlock) / 2n
      const [left, right] = await Promise.all([
        fetchTransferLogs(contractAddress, fromBlock, mid),
        fetchTransferLogs(contractAddress, mid + 1n, toBlock),
      ])
      return [...left, ...right]
    }
    throw error
  }
}

/**
 * Format bigint wei to human-readable string with decimals.
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number = 18,
): string {
  return formatEther(amount)
}

/**
 * Sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === maxRetries) throw error
      const delay = baseDelayMs * Math.pow(2, attempt)
      console.warn(
        `[Retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`,
      )
      await sleep(delay)
    }
  }
  throw new Error('Unreachable')
}

