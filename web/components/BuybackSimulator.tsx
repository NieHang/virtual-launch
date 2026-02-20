'use client'

import { useState } from 'react'
import { api, type BuybackSimulation } from '@/lib/api'
import {
  formatWei,
  formatPrice,
  formatUsd,
} from '@/lib/format'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'

interface Props {
  projectId: string
  phase: 'INTERNAL' | 'EXTERNAL'
  virtualUsdPrice?: number | null
  graduationTaxVirtual?: string | null
  buybackSpentVirtual?: string | null
  remainingTaxVirtual?: string | null
}

export function BuybackSimulator({
  projectId,
  phase,
  virtualUsdPrice,
  graduationTaxVirtual,
  buybackSpentVirtual,
  remainingTaxVirtual,
}: Props) {
  // Buyback amount per interval in VIRTUAL (human readable)
  const [amountPerStep, setAmountPerStep] = useState('100')
  // Total tax budget in VIRTUAL (human readable)
  const [totalTaxInput, setTotalTaxInput] = useState('1000')
  // Interval between steps in seconds
  const [intervalSeconds, setIntervalSeconds] = useState(60)
  const [realisticMode, setRealisticMode] = useState(false)
  const [anchorToSpotPrice, setAnchorToSpotPrice] = useState(true)

  const [result, setResult] = useState<BuybackSimulation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0
  const hasRemainingTax = remainingTaxVirtual !== null && remainingTaxVirtual !== undefined

  const totalBudget = parseFloat(totalTaxInput || '0')
  const expectedSteps = Math.ceil(
    (parseFloat(totalTaxInput || '0') || 0) / Math.max(0.0000001, parseFloat(amountPerStep || '0') || 0.0000001),
  )
  const totalDurationSeconds = intervalSeconds * (Number.isFinite(expectedSteps) ? expectedSteps : 0)

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60 ? (seconds % 60) + 's' : ''}`.trim()
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m ? m + 'm' : ''}`.trim()
  }

  const fmtPrice = (v: number | null): string => {
    if (v === null) return '-'
    return hasUsd ? formatUsd(v * virtualUsdPrice!) : formatPrice(v)
  }

  const runSimulation = async () => {
    setLoading(true)
    setError(null)
    try {
      // Convert VIRTUAL to wei (18 decimals)
      const amountWei = amountPerStep
        ? (
            BigInt(Math.floor(parseFloat(amountPerStep) * 1e6)) * BigInt(1e12)
          ).toString()
        : '0'
      const totalTaxWei = totalTaxInput
        ? (
            BigInt(Math.floor(parseFloat(totalTaxInput) * 1e6)) * BigInt(1e12)
          ).toString()
        : '0'

      const sim = await api.simulateBuyback(projectId, {
        amountPerStep: amountWei,
        intervalSeconds,
        totalTaxInput: totalTaxWei,
        realisticMode,
        anchorToSpotPrice,
      })
      setResult(sim)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Show all points if reasonable, otherwise sample
  const maxChartPoints = 60
  const chartData = result
    ? result.priceTrajectory.length <= maxChartPoints
      ? result.priceTrajectory
      : result.priceTrajectory.filter((_, i) => {
          const interval = Math.ceil(result.priceTrajectory.length / maxChartPoints)
          return i % interval === 0 || i === result.priceTrajectory.length - 1
        })
    : []

  // Convert chart prices to USD if available
  const displayChartData = hasUsd
    ? chartData.map((d) => ({ ...d, price: d.price * virtualUsdPrice! }))
    : chartData

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)]">
        <h3 className="font-semibold">Buyback Simulator</h3>
        <p className="text-xs text-[var(--muted)] mt-1">
          Simulate buyback tax impact on price by interval amount and total tax budget
        </p>
        {phase === 'INTERNAL' && (
          <p className="text-xs text-yellow-400 mt-1">
            Internal mode: simulation uses current market wallet balances as reserves.
          </p>
        )}
      </div>

      <div className="p-4">
        {/* Controls */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-xs text-[var(--muted)] mb-1">
              Buyback Amount Per Interval (VIRTUAL)
            </label>
            <input
              type="number"
              value={amountPerStep}
              onChange={(e) => setAmountPerStep(e.target.value)}
              placeholder="100"
              min="0.1"
              step="10"
              className="w-full bg-black/30 border border-[var(--card-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>
          <div className="w-40">
            <label className="block text-xs text-[var(--muted)] mb-1">
              Total Buyback Tax (VIRTUAL)
            </label>
            <input
              type="number"
              value={totalTaxInput}
              onChange={(e) => setTotalTaxInput(e.target.value)}
              placeholder="1000"
              min="0.1"
              step="10"
              className="w-full bg-black/30 border border-[var(--card-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
            {hasRemainingTax && (
              <button
                type="button"
                onClick={() => setTotalTaxInput((Number(BigInt(remainingTaxVirtual!)) / 1e18).toFixed(4))}
                className="mt-2 text-xs text-[var(--accent)] hover:underline"
              >
                Use remaining tax
              </button>
            )}
          </div>
          <div className="w-40">
            <label className="block text-xs text-[var(--muted)] mb-1">
              Interval (seconds)
            </label>
            <input
              type="number"
              value={intervalSeconds}
              onChange={(e) => setIntervalSeconds(Math.max(1, parseInt(e.target.value) || 1))}
              min="1"
              max="86400"
              placeholder="60"
              className="w-full bg-black/30 border border-[var(--card-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs text-[var(--muted)] pb-2">
              <input
                type="checkbox"
                checked={realisticMode}
                onChange={(e) => setRealisticMode(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Realistic mode
            </label>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs text-[var(--muted)] pb-2">
              <input
                type="checkbox"
                checked={anchorToSpotPrice}
                onChange={(e) => setAnchorToSpotPrice(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Anchor to spot price
            </label>
          </div>
          <div className="flex items-end">
            <button
              onClick={runSimulation}
              disabled={loading}
              className="px-6 py-2 bg-[var(--accent)] text-white rounded-md text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {loading ? 'Running...' : 'Simulate'}
            </button>
          </div>
        </div>

        {/* Summary line */}
        <div className="text-xs text-[var(--muted)] mb-4 flex gap-4 flex-wrap">
          <span>Total Budget: <span className="text-white font-mono">
            {hasUsd ? formatUsd(totalBudget * virtualUsdPrice!) : `${totalBudget.toFixed(1)} V`}
          </span></span>
          <span>Total Duration: <span className="text-white font-mono">{formatDuration(totalDurationSeconds)}</span></span>
          <span>Buy {amountPerStep || '?'}V every {formatDuration(intervalSeconds)} (auto steps: {expectedSteps || 0})</span>
        </div>
        {hasRemainingTax && (
          <div className="text-xs text-[var(--muted)] mb-4 flex gap-4 flex-wrap">
            <span>
              Graduation Tax: <span className="text-white font-mono">
                {graduationTaxVirtual ? `${formatWei(graduationTaxVirtual, 18, 2)} V` : '-'}
              </span>
            </span>
            <span>
              Buyback Spent: <span className="text-white font-mono">
                {buybackSpentVirtual ? `${formatWei(buybackSpentVirtual, 18, 2)} V` : '-'}
              </span>
            </span>
            <span>
              Remaining Tax: <span className="text-emerald-400 font-mono">
                {remainingTaxVirtual ? `${formatWei(remainingTaxVirtual, 18, 2)} V` : '-'}
              </span>
            </span>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-800 rounded-md p-3 text-sm text-red-400 mb-4">
            {error}
          </div>
        )}

        {result && (
          <>
            {/* Results summary */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-xs text-[var(--muted)]">Total Spent</p>
                <p className="font-mono font-bold text-sm">
                  {hasUsd
                    ? formatUsd(Number(BigInt(result.budget)) / 1e18 * virtualUsdPrice!)
                    : `${formatWei(result.budget)} V`}
                </p>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-xs text-[var(--muted)]">Buybacks</p>
                <p className="font-mono font-bold text-sm">
                  {result.steps}
                </p>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-xs text-[var(--muted)]">Tokens Bought</p>
                <p className="font-mono font-bold text-sm">
                  {formatWei(result.totalTokensBought)}
                </p>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-xs text-[var(--muted)]">Avg Price</p>
                <p className="font-mono font-bold text-sm">
                  {fmtPrice(result.avgPrice)}
                </p>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-xs text-[var(--muted)]">Final Price</p>
                <p className="font-mono font-bold text-sm">
                  {fmtPrice(result.finalPrice)}
                </p>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <p className="text-xs text-[var(--muted)]">Price Impact</p>
                <p
                  className={`font-mono font-bold text-sm ${
                    result.priceImpactPercent > 10
                      ? 'text-red-400'
                      : result.priceImpactPercent > 5
                        ? 'text-yellow-400'
                        : 'text-green-400'
                  }`}
                >
                  +{result.priceImpactPercent.toFixed(2)}%
                </p>
              </div>
            </div>
            <div className="text-xs text-[var(--muted)] mb-4">
              Assumptions: mode={result.assumptions.mode}, no external sells={result.assumptions.noExternalSells ? 'yes' : 'no'}, LP reserves={result.assumptions.useCurrentLpReserves ? 'yes' : 'no'}, sell pressure={result.assumptions.sellPressureBpsPerStep / 100}% per interval, price anchor={result.assumptions.priceAnchor || 'RESERVE'}.
            </div>

            {/* Price trajectory chart */}
            {displayChartData.length > 0 && (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={displayChartData}>
                    <CartesianGrid stroke="#1e1e2e" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="elapsed"
                      tick={{ fill: '#6b7280', fontSize: 10 }}
                      axisLine={{ stroke: '#1e1e2e' }}
                    />
                    <YAxis
                      tick={{ fill: '#6b7280', fontSize: 10 }}
                      axisLine={{ stroke: '#1e1e2e' }}
                      tickFormatter={(v) => hasUsd ? formatUsd(v) : formatPrice(v)}
                      domain={['dataMin', 'dataMax']}
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
                        hasUsd ? formatUsd(value) : formatPrice(value),
                        'Price',
                      ]}
                      labelFormatter={(label) => `Elapsed: ${label}`}
                    />
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke="#8b5cf6"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
