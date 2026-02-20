import { type Address } from 'viem'
import { getClient } from '../chain/client.js'
import { fetchTransferLogs } from '../chain/utils.js'
import { config } from '../config.js'

/**
 * Find the first block where the token contract emitted a Transfer event.
 * Uses adaptive backward scanning + binary search.
 *
 * Algorithm:
 * 1. Start from `latest`, scan backwards in windows of initialScanWindow blocks
 * 2. Double window size on miss until we find a window with Transfer logs
 * 3. Binary search within the hit window to find the exact first block
 */
export async function findFirstActiveBlock(
  tokenAddress: Address,
): Promise<number> {
  const client = getClient()
  const latestBlock = Number(await client.getBlockNumber())

  let windowSize: number = config.initialScanWindow
  let toBlock = latestBlock
  let hitFromBlock = 0
  let hitToBlock = latestBlock
  let found = false

  console.log(
    `[FirstBlock] Searching for first Transfer of ${tokenAddress} from block ${latestBlock}`,
  )

  // Phase 1: Adaptive backward scan to find a window containing Transfer logs
  while (!found && toBlock > 0) {
    const fromBlock = Math.max(0, toBlock - windowSize)

    console.log(
      `[FirstBlock] Scanning window [${fromBlock}, ${toBlock}] (size=${windowSize})`,
    )

    try {
      const logs = await fetchTransferLogs(
        tokenAddress,
        BigInt(fromBlock),
        BigInt(toBlock),
      )

      if (logs.length > 0) {
        hitFromBlock = fromBlock
        hitToBlock = toBlock
        found = true
        console.log(
          `[FirstBlock] Found ${logs.length} Transfer logs in window [${fromBlock}, ${toBlock}]`,
        )
      } else {
        // Move window back and expand
        toBlock = fromBlock - 1
        windowSize = Math.min(windowSize * 2, config.maxScanWindow)
      }
    } catch (error) {
      // On error (rate limit etc.), shrink window and retry
      windowSize = Math.max(Math.floor(windowSize / 2), 1000)
      console.warn(
        `[FirstBlock] Error scanning, shrinking window to ${windowSize}`,
      )
    }
  }

  if (!found) {
    console.warn(
      `[FirstBlock] No Transfer events found for ${tokenAddress}, using block 0`,
    )
    return 0
  }

  // Phase 2: Binary search within the hit window to find the exact first block
  let lo = hitFromBlock
  let hi = hitToBlock
  let firstBlock = hitToBlock

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)

    try {
      const logs = await fetchTransferLogs(
        tokenAddress,
        BigInt(lo),
        BigInt(mid),
      )

      if (logs.length > 0) {
        // Found logs in [lo, mid] - narrow down
        const earliestLogBlock = Math.min(
          ...logs.map((l) => Number(l.blockNumber)),
        )
        firstBlock = earliestLogBlock
        hi = earliestLogBlock - 1
      } else {
        // No logs in [lo, mid] - search in [mid+1, hi]
        lo = mid + 1
      }
    } catch {
      // On error, try smaller range
      hi = Math.floor((lo + hi) / 2)
    }
  }

  console.log(
    `[FirstBlock] First active block for ${tokenAddress}: ${firstBlock}`,
  )
  return firstBlock
}

