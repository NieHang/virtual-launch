import { getAddress, type Address } from 'viem'

export interface TransferLogFailureStat {
  contractAddress: string
  failureCount: number
  lastFailureAt: number
  lastFailureRange: {
    fromBlock: string
    toBlock: string
  }
  lastError: string
}

const transferLogFailureStats = new Map<string, TransferLogFailureStat>()

export function recordTransferLogFailure(
  contractAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  errorMessage: string,
): void {
  const normalized = getAddress(contractAddress).toLowerCase()
  const existing = transferLogFailureStats.get(normalized)

  transferLogFailureStats.set(normalized, {
    contractAddress: normalized,
    failureCount: (existing?.failureCount || 0) + 1,
    lastFailureAt: Math.floor(Date.now() / 1000),
    lastFailureRange: {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
    },
    lastError: errorMessage.slice(0, 300),
  })
}

export function getTransferLogFailureStat(
  contractAddress: Address,
): TransferLogFailureStat | null {
  const normalized = getAddress(contractAddress).toLowerCase()
  return transferLogFailureStats.get(normalized) || null
}
