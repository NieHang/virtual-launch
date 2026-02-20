import { type Address, type Log } from 'viem'
import { getClient } from '../chain/client.js'
import { VIRTUAL_ADDRESS, SWAP_TOPIC } from '../chain/constants.js'
import { fetchTransferLogs, parseTransferLogs } from '../chain/utils.js'
import type { ParsedTransfer } from '../types.js'

export interface BlockData {
  blockNumber: number
  timestamp: number
  tokenTransfers: ParsedTransfer[]
  virtualTransfers: ParsedTransfer[]
}

/**
 * Fetch all relevant Transfer logs for a given block range.
 * Returns token and VIRTUAL transfers grouped by block.
 *
 * @param skipVirtualTransfers - If true, skip fetching VIRTUAL Transfer logs
 *   (for graduated projects that only need Swap events, saves ~75 CU per cycle)
 */
export async function scanBlockRange(
  tokenAddress: Address,
  fromBlock: number,
  toBlock: number,
  skipVirtualTransfers = false,
): Promise<BlockData[]> {
  // Fetch Transfer logs (skip VIRTUAL logs for graduated projects to save RPC calls)
  const tokenLogsPromise = fetchTransferLogs(tokenAddress, BigInt(fromBlock), BigInt(toBlock))

  const [tokenLogs, virtualLogs] = await Promise.all([
    tokenLogsPromise,
    skipVirtualTransfers
      ? Promise.resolve([])
      : fetchTransferLogs(VIRTUAL_ADDRESS as Address, BigInt(fromBlock), BigInt(toBlock)),
  ])

  const tokenTransfers = parseTransferLogs(tokenLogs)
  const virtualTransfers = parseTransferLogs(virtualLogs)

  // Group by block number
  const blockMap = new Map<number, BlockData>()

  const ensureBlock = (blockNumber: number) => {
    if (!blockMap.has(blockNumber)) {
      blockMap.set(blockNumber, {
        blockNumber,
        timestamp: 0, // Will be filled later
        tokenTransfers: [],
        virtualTransfers: [],
      })
    }
    return blockMap.get(blockNumber)!
  }

  for (const t of tokenTransfers) {
    ensureBlock(t.blockNumber).tokenTransfers.push(t)
  }
  for (const v of virtualTransfers) {
    ensureBlock(v.blockNumber).virtualTransfers.push(v)
  }

  // Sort blocks and fetch timestamps
  const blocks = [...blockMap.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber,
  )

  // Batch fetch block timestamps
  if (blocks.length > 0) {
    const client = getClient()
    const timestamps = await Promise.all(
      blocks.map(async (b) => {
        try {
          const block = await client.getBlock({
            blockNumber: BigInt(b.blockNumber),
          })
          return Number(block.timestamp)
        } catch {
          return Math.floor(Date.now() / 1000)
        }
      }),
    )

    for (let i = 0; i < blocks.length; i++) {
      blocks[i].timestamp = timestamps[i]
    }
  }

  return blocks
}

/**
 * Fetch Swap events from a Uniswap V2 pair for a block range.
 */
export async function fetchSwapLogs(
  pairAddress: Address,
  fromBlock: number,
  toBlock: number,
): Promise<Log[]> {
  const client = getClient()

  try {
    return await client.getLogs({
      address: pairAddress,
      event: {
        type: 'event',
        name: 'Swap',
        inputs: [
          { type: 'address', name: 'sender', indexed: true },
          { type: 'uint256', name: 'amount0In', indexed: false },
          { type: 'uint256', name: 'amount1In', indexed: false },
          { type: 'uint256', name: 'amount0Out', indexed: false },
          { type: 'uint256', name: 'amount1Out', indexed: false },
          { type: 'address', name: 'to', indexed: true },
        ],
      },
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    })
  } catch (error: any) {
    const msg = error?.message || ''
    if (
      msg.includes('range') ||
      msg.includes('limit') ||
      msg.includes('too many')
    ) {
      if (toBlock - fromBlock <= 1) return []
      const mid = Math.floor((fromBlock + toBlock) / 2)
      const [left, right] = await Promise.all([
        fetchSwapLogs(pairAddress, fromBlock, mid),
        fetchSwapLogs(pairAddress, mid + 1, toBlock),
      ])
      return [...left, ...right]
    }
    throw error
  }
}

