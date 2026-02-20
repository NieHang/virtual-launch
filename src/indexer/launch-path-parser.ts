import type { ParsedTransfer } from '../types.js'

export interface TxTransferGroup {
  token: ParsedTransfer[]
  virtual: ParsedTransfer[]
}

// Protocol-specific path addresses used by launch internal execution.
export const LAUNCH_PATH_NET_ADDRESS =
  '0x0000000071727de22e5e9d8baf0edac6f37da032'
export const LAUNCH_PATH_TAX_ADDRESS =
  '0xc3538ddd84619e761b4c03caf2f785f79889958d'

const LAUNCH_PATH_ADDRESSES = new Set([
  LAUNCH_PATH_NET_ADDRESS.toLowerCase(),
  LAUNCH_PATH_TAX_ADDRESS.toLowerCase(),
])

export function hasLaunchPathTransfers(group: TxTransferGroup): boolean {
  for (const v of group.virtual) {
    if (
      LAUNCH_PATH_ADDRESSES.has(v.from.toLowerCase()) ||
      LAUNCH_PATH_ADDRESSES.has(v.to.toLowerCase())
    ) {
      return true
    }
  }
  return false
}

export function inferLaunchPathBuyQuote(
  group: TxTransferGroup,
  traderLower: string,
): { gross: bigint; net: bigint } {
  let gross = 0n
  let netToPrimary = 0n
  let maxSingleRecipient = 0n
  const byRecipient = new Map<string, bigint>()

  for (const v of group.virtual) {
    const fromLower = v.from.toLowerCase()
    const toLower = v.to.toLowerCase()
    if (fromLower !== traderLower || !LAUNCH_PATH_ADDRESSES.has(toLower)) continue

    gross += v.value
    const next = (byRecipient.get(toLower) || 0n) + v.value
    byRecipient.set(toLower, next)
    if (next > maxSingleRecipient) maxSingleRecipient = next
    if (toLower === LAUNCH_PATH_NET_ADDRESS.toLowerCase()) {
      netToPrimary += v.value
    }
  }

  let net = netToPrimary > 0n ? netToPrimary : maxSingleRecipient
  if (net <= 0n) net = gross
  if (net > gross) net = gross

  return { gross, net }
}

export function inferLaunchPathSellQuoteOut(
  group: TxTransferGroup,
  traderLower: string,
): bigint {
  let quoteOut = 0n
  for (const v of group.virtual) {
    if (
      v.to.toLowerCase() === traderLower &&
      LAUNCH_PATH_ADDRESSES.has(v.from.toLowerCase())
    ) {
      quoteOut += v.value
    }
  }
  return quoteOut
}
