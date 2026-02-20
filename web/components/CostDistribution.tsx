'use client'

import { useEffect, useState } from 'react'
import { api, type CostSummary } from '@/lib/api'
import { formatPrice, formatUsd } from '@/lib/format'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

interface Props {
  projectId: string
  spotPrice: number | null
  virtualUsdPrice?: number | null
}

export function CostDistribution({ projectId, spotPrice, virtualUsdPrice }: Props) {
  const [summary, setSummary] = useState<CostSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [unit, setUnit] = useState<'V_PER_TOKEN' | 'USD_PER_TOKEN'>('V_PER_TOKEN')
  const [sellTaxPct, setSellTaxPct] = useState(0)
  const [feePct, setFeePct] = useState(1)
  const [slippagePct, setSlippagePct] = useState(5)

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  useEffect(() => {
    if (hasUsd) {
      setUnit('USD_PER_TOKEN')
    } else {
      setUnit('V_PER_TOKEN')
    }
  }, [hasUsd])

  useEffect(() => {
    api
      .getCostSummary(projectId)
      .then(setSummary)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [projectId])

  if (loading) {
    return (
      <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-8 text-center text-[var(--muted)]">
        Loading cost data...
      </div>
    )
  }

  if (!summary || summary.addressCount === 0) {
    return (
      <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-8 text-center text-[var(--muted)]">
        No cost data yet
      </div>
    )
  }

  // Helper to format cost value based on USD availability
  const fmtCost = (v: number | null): string => {
    if (v === null) return '-'
    if (unit === 'USD_PER_TOKEN' && hasUsd) return formatUsd(v * virtualUsdPrice!)
    return formatPrice(v)
  }

  // Create histogram-like data from percentiles
  const chartData = [
    { label: 'P50', value: summary.p50 || 0 },
    { label: 'P75', value: summary.p75 || 0 },
    { label: 'P90', value: summary.p90 || 0 },
    { label: 'Weighted', value: summary.weightedAvgCost || 0 },
    { label: 'Equal Wt', value: summary.equalWeightAvgCost || 0 },
  ].filter((d) => d.value > 0)

  // If showing USD, convert chart data values
  const showUsd = unit === 'USD_PER_TOKEN' && hasUsd
  const displayData = showUsd
    ? chartData.map((d) => ({ ...d, value: d.value * virtualUsdPrice! }))
    : chartData

  const displaySpot = spotPrice !== null && showUsd
    ? spotPrice * virtualUsdPrice!
    : spotPrice
  const tokenSpotUsd = showUsd && spotPrice !== null ? spotPrice * virtualUsdPrice! : null

  const weightedCostV = summary?.weightedAvgCost ?? null
  const markPriceV = spotPrice
  const sellFactor =
    (1 - sellTaxPct / 100) * (1 - feePct / 100) * (1 - slippagePct / 100)
  const realizablePriceV =
    markPriceV !== null ? Math.max(0, markPriceV * Math.max(0, sellFactor)) : null

  const toDisplay = (v: number | null): number | null => {
    if (v === null) return null
    return showUsd && hasUsd ? v * virtualUsdPrice! : v
  }

  const weightedCostDisplay = toDisplay(weightedCostV)
  const markPriceDisplay = toDisplay(markPriceV)
  const realizablePriceDisplay = toDisplay(realizablePriceV)

  const markRatio =
    weightedCostV && weightedCostV > 0 && markPriceV !== null
      ? markPriceV / weightedCostV
      : null
  const realizableRatio =
    weightedCostV && weightedCostV > 0 && realizablePriceV !== null
      ? realizablePriceV / weightedCostV
      : null

  const ratioText = (ratio: number | null): string =>
    ratio === null ? '-' : `${(ratio * 100).toFixed(1)}%`
  const pnlText = (ratio: number | null): string =>
    ratio === null ? '-'
      : `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)]">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">
            Cost Distribution ({showUsd ? 'USD/Token' : 'V/Token'})
          </h3>
          {hasUsd && (
            <div className="flex items-center gap-1 rounded-md border border-[var(--card-border)] p-1">
              <button
                type="button"
                onClick={() => setUnit('V_PER_TOKEN')}
                className={`px-2 py-1 text-xs rounded ${
                  unit === 'V_PER_TOKEN'
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--muted)]'
                }`}
              >
                V/token
              </button>
              <button
                type="button"
                onClick={() => setUnit('USD_PER_TOKEN')}
                className={`px-2 py-1 text-xs rounded ${
                  unit === 'USD_PER_TOKEN'
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--muted)]'
                }`}
              >
                USD/token
              </button>
            </div>
          )}
        </div>
        <p className="text-xs text-[var(--muted)] mt-1">
          {summary.addressCount} addresses tracked
        </p>
      </div>

      <div className="p-4">
        {showUsd && (
          <div className="text-xs text-[var(--muted)] mb-4">
            Cost Distribution uses <span className="text-white">USD/Token</span>.
            Current token price = <span className="text-white">{tokenSpotUsd !== null ? formatUsd(tokenSpotUsd) : '-'}</span>
            {' '}({spotPrice !== null ? formatPrice(spotPrice) : '-'} V/token x {virtualUsdPrice !== null ? formatUsd(virtualUsdPrice) : '-'} per VIRTUAL).
          </div>
        )}

        <div className="bg-black/20 rounded-lg p-3 mb-4 border border-[var(--card-border)]">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-[var(--muted)] uppercase tracking-wide">
              Break-even Check
            </p>
            <p className="text-xs text-[var(--muted)]">
              weighted avg cost basis
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div>
              <p className="text-xs text-[var(--muted)]">Weighted Cost</p>
              <p className="font-mono text-sm font-semibold">
                {showUsd ? formatUsd(weightedCostDisplay) : formatPrice(weightedCostDisplay)}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Current Price</p>
              <p className="font-mono text-sm font-semibold">
                {showUsd ? formatUsd(markPriceDisplay) : formatPrice(markPriceDisplay)}
              </p>
              <p className={`text-xs ${markRatio !== null && markRatio >= 1 ? 'text-green-400' : 'text-red-400'}`}>
                {ratioText(markRatio)} of cost ({pnlText(markRatio)})
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Realizable Price</p>
              <p className="font-mono text-sm font-semibold">
                {showUsd ? formatUsd(realizablePriceDisplay) : formatPrice(realizablePriceDisplay)}
              </p>
              <p className={`text-xs ${realizableRatio !== null && realizableRatio >= 1 ? 'text-green-400' : 'text-red-400'}`}>
                {ratioText(realizableRatio)} of cost ({pnlText(realizableRatio)})
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-[var(--muted)]">
              Sell tax %
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={sellTaxPct}
                onChange={(e) => setSellTaxPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="mt-1 w-full bg-black/30 border border-[var(--card-border)] rounded px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-[var(--muted)]">
              Fee %
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={feePct}
                onChange={(e) => setFeePct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="mt-1 w-full bg-black/30 border border-[var(--card-border)] rounded px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-[var(--muted)]">
              Slippage %
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={slippagePct}
                onChange={(e) => setSlippagePct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="mt-1 w-full bg-black/30 border border-[var(--card-border)] rounded px-2 py-1 text-sm"
              />
            </label>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {[
            { label: 'Weighted Avg', value: summary.weightedAvgCost },
            { label: 'Equal Weight', value: summary.equalWeightAvgCost },
            { label: 'P50 (Median)', value: summary.p50 },
            { label: 'P75', value: summary.p75 },
            { label: 'P90', value: summary.p90 },
          ].map((item) => (
            <div key={item.label} className="text-center">
              <p className="text-xs text-[var(--muted)] mb-1">{item.label}</p>
              <p className="font-mono font-bold text-sm">
                {fmtCost(item.value)}
              </p>
            </div>
          ))}
        </div>

        {/* Bar chart */}
        {displayData.length > 0 && (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={displayData}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#1e1e2e' }}
                />
                <YAxis
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#1e1e2e' }}
                  tickFormatter={(v) => showUsd ? formatUsd(v) : formatPrice(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: '#12121a',
                    border: '1px solid #1e1e2e',
                    borderRadius: '8px',
                    color: '#e4e4ef',
                    fontSize: '12px',
                  }}
                  formatter={(value: number) => [
                    showUsd ? formatUsd(value) : formatPrice(value),
                    'Cost',
                  ]}
                />
                <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                {displaySpot !== null && (
                  <ReferenceLine
                    y={displaySpot}
                    stroke="#22c55e"
                    strokeDasharray="3 3"
                    label={{
                      value: 'Current',
                      fill: '#22c55e',
                      fontSize: 10,
                    }}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}
