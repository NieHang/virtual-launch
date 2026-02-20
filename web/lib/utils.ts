import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a wei value as a human-readable number with optional suffix.
 */
export function formatWei(
  wei: string | null | undefined,
  decimals = 18,
  maxDecimals = 4,
): string {
  if (!wei || wei === '0') return '0'
  const value = Number(BigInt(wei)) / Math.pow(10, decimals)
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return value.toFixed(maxDecimals)
}

/**
 * Format number with optional suffix.
 */
export function formatNumber(
  value: number | null | undefined,
  maxDecimals = 4,
): string {
  if (value == null) return '-'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return value.toFixed(maxDecimals)
}

/**
 * Shorten an address for display.
 */
export function shortenAddress(address: string, chars = 4): string {
  if (!address || address.length < 10) return address
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

/**
 * Format a timestamp as a relative time string.
 */
export function timeAgo(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts

  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

/**
 * Format percentage.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '-'
  return `${(value * 100).toFixed(2)}%`
}

