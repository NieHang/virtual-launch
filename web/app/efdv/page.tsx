'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { computeLayeredEfdv } from '@/lib/efdv'
import { formatPercentCeil, formatPrice, formatUsd } from '@/lib/format'

const FIXED_SUPPLY = 1_000_000_000
const FIXED_BASE_PRICE = 42_000 / FIXED_SUPPLY
const BASE_FDV_V = FIXED_BASE_PRICE * FIXED_SUPPLY

export default function EfdvCalculatorPage() {
  const [prebuyPctInput, setPrebuyPctInput] = useState('0')
  const [virtualUsdPrice, setVirtualUsdPrice] = useState<number | null>(null)
  const [rateLoading, setRateLoading] = useState(true)

  const prebuyRatio = useMemo(() => {
    const parsed = Number(prebuyPctInput)
    if (!Number.isFinite(parsed)) return 0
    const normalizedPct = Math.min(Math.max(parsed, 0), 99)
    return normalizedPct / 100
  }, [prebuyPctInput])

  useEffect(() => {
    let cancelled = false

    const loadVirtualUsd = async () => {
      setRateLoading(true)
      try {
        const projects = await api.getProjects()
        if (!projects.length) {
          if (!cancelled) setVirtualUsdPrice(null)
          return
        }
        const state = await api.getProjectState(projects[0].id)
        if (!cancelled) {
          setVirtualUsdPrice(
            state.virtualUsdPrice && state.virtualUsdPrice > 0 ? state.virtualUsdPrice : null,
          )
        }
      } catch {
        if (!cancelled) setVirtualUsdPrice(null)
      } finally {
        if (!cancelled) setRateLoading(false)
      }
    }

    loadVirtualUsd()
    const interval = setInterval(loadVirtualUsd, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const result = useMemo(() => {
    return computeLayeredEfdv(FIXED_SUPPLY, FIXED_BASE_PRICE, prebuyRatio)
  }, [prebuyRatio])
  const baseFdvUsdc = virtualUsdPrice ? BASE_FDV_V * virtualUsdPrice : null
  const prebuyAdjustedFdvV = BASE_FDV_V * result.prebuyMultiplier
  const prebuyAdjustedFdvUsdc = virtualUsdPrice ? prebuyAdjustedFdvV * virtualUsdPrice : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">EFDV Calculator</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            Layered EFDV with pre-buy ratio uplift
          </p>
        </div>
        <Link href="/" className="text-[var(--accent)] hover:underline text-sm">
          Back to projects
        </Link>
      </div>

      <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-xs text-[var(--muted)] md:col-span-1">
            Pre-buy ratio (%)
            <input
              type="number"
              min={0}
              max={99}
              step={0.1}
              value={prebuyPctInput}
              onChange={(e) => setPrebuyPctInput(e.target.value)}
              className="mt-1 w-full bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-sm font-mono"
            />
          </label>
          <div className="text-xs text-[var(--muted)] md:col-span-2 flex items-end">
            {rateLoading ? 'Loading VIRTUAL/USDC rate...' : virtualUsdPrice ? `Realtime VIRTUAL/USDC: ${virtualUsdPrice.toFixed(4)}` : 'Rate unavailable'}
          </div>
        </div>
        <p className="text-xs text-[var(--muted)]">
          Fixed params: Supply = 1,000,000,000 tokens, Base price = {formatPrice(FIXED_BASE_PRICE)} V (42000 / 1e9)
        </p>
        <div className="text-xs text-[var(--muted)] grid grid-cols-1 md:grid-cols-2 gap-2">
          <span>
            Base FDV (V): <span className="text-white font-mono">42,000</span>
          </span>
          <span>
            Realtime V/USDC:{' '}
            <span className="text-white font-mono">
              {virtualUsdPrice ? virtualUsdPrice.toFixed(6) : 'Rate unavailable'}
            </span>
          </span>
          <span>
            Base FDV (USDC):{' '}
            <span className="text-white font-mono">
              {baseFdvUsdc ? formatUsd(baseFdvUsdc) : '-'}
            </span>
          </span>
          <span>
            Prebuy-adjusted FDV (USDC):{' '}
            <span className="text-white font-mono">
              {prebuyAdjustedFdvUsdc ? formatUsd(prebuyAdjustedFdvUsdc) : '-'}
            </span>
          </span>
        </div>
        <p className="text-xs text-[var(--muted)]">
          Formula: FDV = baseFDV x 1 / (1 - prebuyRatio), EFDV = FDV / (1 - tax)
        </p>
      </div>

      <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
        <div className="p-4 border-b border-[var(--card-border)] text-xs text-[var(--muted)] flex flex-wrap gap-4">
          <span>
            Base price: <span className="text-white font-mono">{formatPrice(result.basePrice)} V</span>
          </span>
          <span>
            Tax model: <span className="text-white font-mono">{result.taxModel}</span>
          </span>
          <span>
            Prebuy multiplier:
            <span className="text-white font-mono ml-1">{result.prebuyMultiplier.toFixed(4)}x</span>
          </span>
        </div>
        <div className="overflow-x-auto p-4">
          <p className="text-xs text-[var(--muted)] mb-2">
            At a fixed pre-buy ratio, tax layers only change EFDV; FDV stays the same across rows.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                <th className="text-left p-2">Tax Layer</th>
                <th className="text-right p-2">FDV (USDC)</th>
                <th className="text-right p-2">EFDV (USDC)</th>
                <th className="text-right p-2">Breakeven</th>
              </tr>
            </thead>
            <tbody>
              {result.layers.map((row) => (
                <tr key={row.taxRate} className="border-b border-[var(--card-border)]">
                  <td className="p-2 font-mono">{formatPercentCeil(row.taxRate)}</td>
                  <td className="p-2 text-right font-mono">
                    {virtualUsdPrice ? formatUsd(row.impliedFdv * virtualUsdPrice) : '-'}
                  </td>
                  <td className="p-2 text-right font-mono">
                    {virtualUsdPrice ? formatUsd(row.impliedEfdv * virtualUsdPrice) : '-'}
                  </td>
                  <td className="p-2 text-right font-mono">{row.breakevenMultiple.toFixed(2)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
