import { type Address, getAddress } from 'viem'
import { getClient } from '../chain/client.js'
import { TOKEN_ABI, VIRTUAL_ADDRESS } from '../chain/constants.js'
import { parseTransferLogs } from '../chain/utils.js'
import type { ParsedTransfer, TaxInflow } from '../types.js'

/**
 * Read the tax recipient address from the token contract.
 */
export async function readTaxRecipient(
  tokenAddress: Address,
): Promise<Address | null> {
  const client = getClient()
  try {
    const recipient = (await client.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: 'projectTaxRecipient',
    })) as Address

    if (
      recipient &&
      recipient !== '0x0000000000000000000000000000000000000000'
    ) {
      return getAddress(recipient)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read buy tax basis points from the token contract.
 */
export async function readBuyTaxBps(
  tokenAddress: Address,
): Promise<number | null> {
  const client = getClient()
  try {
    const bps = (await client.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName: 'totalBuyTaxBasisPoints',
    })) as bigint
    return Number(bps)
  } catch {
    return null
  }
}

/**
 * Get the tax rate based on time-decay model.
 * Starts at 99% (9900 bps), decays linearly to 1% (100 bps) over 98 minutes.
 */
export function getDecayTaxRate(
  firstTradeTs: number,
  currentTs: number,
): number {
  const elapsedMs = (currentTs - firstTradeTs) * 1000
  const decayDurationMs = 98 * 60 * 1000 // 98 minutes

  if (elapsedMs >= decayDurationMs) {
    return 0.01 // 1% floor
  }

  const progress = elapsedMs / decayDurationMs
  // Linear decay from 99% to 1%
  return 0.99 - progress * 0.98
}

/**
 * Extract tax inflows from Transfer logs.
 * Looks for Transfers where `to` is the tax recipient address.
 */
export function extractTaxInflows(
  tokenTransfers: ParsedTransfer[],
  virtualTransfers: ParsedTransfer[],
  taxRecipient: Address,
  projectId: string,
  blockTimestamp: number,
): TaxInflow[] {
  const normalizedRecipient = getAddress(taxRecipient).toLowerCase()
  const inflows: TaxInflow[] = []
  // Only count VIRTUAL inflows that occur in transactions touching this project token.
  // This avoids attributing unrelated transfers to projects that share a tax recipient.
  const tokenTxHashes = new Set(tokenTransfers.map((t) => t.txHash))
  const tokenByTx = new Map<string, ParsedTransfer[]>()
  const virtualByTx = new Map<string, ParsedTransfer[]>()
  for (const t of tokenTransfers) {
    if (!tokenByTx.has(t.txHash)) tokenByTx.set(t.txHash, [])
    tokenByTx.get(t.txHash)!.push(t)
  }
  for (const v of virtualTransfers) {
    if (!virtualByTx.has(v.txHash)) virtualByTx.set(v.txHash, [])
    virtualByTx.get(v.txHash)!.push(v)
  }

  const specialSplitTaxTx = new Set<string>()
  const consumedVirtualLogKeys = new Set<string>()

  // Prefer "split buy" inference:
  // - identify trader->market VIRTUAL payment leg
  // - treat other trader VIRTUAL outflows (excluding taxRecipient fee leg) as true tax
  for (const [txHash, txTokenTransfers] of tokenByTx) {
    const txVirtual = virtualByTx.get(txHash) || []
    if (txVirtual.length === 0) continue

    // BUY proxy: largest token out transfer in tx (market -> trader)
    const tokenOut = [...txTokenTransfers].sort((a, b) =>
      b.value > a.value ? 1 : b.value < a.value ? -1 : 0,
    )[0]
    if (!tokenOut) continue
    const marketLower = tokenOut.from.toLowerCase()
    const traderLower = tokenOut.to.toLowerCase()

    const hasMainBuyLeg = txVirtual.some(
      (v) =>
        v.from.toLowerCase() === traderLower &&
        v.to.toLowerCase() === marketLower &&
        v.value > 0n,
    )
    if (!hasMainBuyLeg) continue

    const splitTaxTransfers = txVirtual.filter(
      (v) =>
        v.from.toLowerCase() === traderLower &&
        v.to.toLowerCase() !== marketLower &&
        v.to.toLowerCase() !== normalizedRecipient &&
        v.value > 0n,
    )
    if (splitTaxTransfers.length === 0) continue

    specialSplitTaxTx.add(txHash)
    for (const v of splitTaxTransfers) {
      const logKey = `${v.txHash}:${v.logIndex}`
      consumedVirtualLogKeys.add(logKey)
      inflows.push({
        projectId,
        txHash: v.txHash,
        blockNumber: v.blockNumber,
        ts: blockTimestamp,
        token: VIRTUAL_ADDRESS,
        amount: v.value.toString(),
        logIndex: v.logIndex,
      })
    }
  }

  for (const t of tokenTransfers) {
    if (t.to.toLowerCase() === normalizedRecipient) {
      inflows.push({
        projectId,
        txHash: t.txHash,
        blockNumber: t.blockNumber,
        ts: blockTimestamp,
        token: t.address, // The token contract address
        amount: t.value.toString(),
        logIndex: t.logIndex,
      })
    }
  }

  for (const v of virtualTransfers) {
    const logKey = `${v.txHash}:${v.logIndex}`
    if (consumedVirtualLogKeys.has(logKey)) continue
    if (specialSplitTaxTx.has(v.txHash)) continue
    if (v.to.toLowerCase() === normalizedRecipient && tokenTxHashes.has(v.txHash)) {
      inflows.push({
        projectId,
        txHash: v.txHash,
        blockNumber: v.blockNumber,
        ts: blockTimestamp,
        token: VIRTUAL_ADDRESS,
        amount: v.value.toString(),
        logIndex: v.logIndex,
      })
    }
  }

  return inflows
}

/**
 * Get the VIRTUAL balance of the tax recipient.
 */
export async function getTaxRecipientBalance(
  taxRecipient: Address,
): Promise<bigint> {
  const client = getClient()
  try {
    const balance = (await client.readContract({
      address: VIRTUAL_ADDRESS as Address,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [taxRecipient],
    })) as bigint
    return balance
  } catch {
    return 0n
  }
}

