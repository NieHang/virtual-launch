/**
 * Convert a bigint wei string to a plain number.
 */
export function weiToNumber(wei: string | null, decimals = 18): number {
  if (!wei || wei === '0') return 0
  try {
    return Number(BigInt(wei)) / Math.pow(10, decimals)
  } catch {
    return 0
  }
}

/**
 * Format a bigint wei string to human-readable token amount.
 */
export function formatWei(
  wei: string | null,
  decimals = 18,
  precision = 4,
): string {
  if (!wei || wei === '0') return '0'
  try {
    const n = weiToNumber(wei, decimals)
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
    return n.toFixed(precision)
  } catch {
    return '0'
  }
}

/**
 * Format a USD amount in a human-readable way.
 */
export function formatUsd(value: number | null): string {
  if (value === null || value === undefined) return '-'
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(4)}`
  if (value >= 0.0001) return `$${value.toFixed(6)}`
  if (value >= 0.000001) return `$${value.toFixed(8)}`
  return `$${value.toFixed(10)}`
}

/**
 * Format a number with commas and fixed decimals.
 */
export function formatNumber(n: number | null, precision = 2): string {
  if (n === null || n === undefined) return '-'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(precision)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(precision)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(precision)}K`
  return n.toFixed(precision)
}

/**
 * Format a price (VIRTUAL per token) in a human-readable way.
 */
export function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return '-'
  if (price < 0.000001) return price.toExponential(4)
  if (price < 0.01) return price.toFixed(8)
  if (price < 1) return price.toFixed(6)
  return price.toFixed(4)
}

/**
 * Format a percentage.
 */
export function formatPercent(value: number | null, precision = 2): string {
  if (value === null || value === undefined) return '-'
  return `${(value * 100).toFixed(precision)}%`
}

/**
 * Format a percentage by always rounding up to integer percent.
 */
export function formatPercentCeil(value: number | null): string {
  if (value === null || value === undefined) return '-'
  return `${Math.ceil(value * 100)}%`
}

/**
 * Format a timestamp to a readable date/time string.
 */
export function formatTime(ts: number): string {
  const date = new Date(ts * 1000)
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Shorten an address for display.
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address) return ''
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

