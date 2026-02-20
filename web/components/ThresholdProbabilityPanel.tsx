'use client'

import { useEffect, useState } from 'react'
import { api, type ThresholdProbabilityResponse } from '@/lib/api'
import { formatPercentCeil, formatUsd } from '@/lib/format'

interface Props {
  projectId: string
}

export function ThresholdProbabilityPanel({ projectId }: Props) {
  const [targetUsd, setTargetUsd] = useState('5000000')
  const [horizonHours, setHorizonHours] = useState(24)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ThresholdProbabilityResponse | null>(null)

  const load = async () => {
    const target = Number(targetUsd)
    if (!Number.isFinite(target) || target <= 0) {
      setError('Target market cap must be a positive number')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await api.getMarketCapThresholdProbability(projectId, target, horizonHours)
      setData(res)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)]">
        <h3 className="font-semibold">Threshold Probability (Buyback Window)</h3>
        <p className="text-xs text-[var(--muted)] mt-1">
          Estimate probability of reaching target market cap during buyback period
        </p>
      </div>
      <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Target Market Cap (USD)</label>
            <input
              type="number"
              value={targetUsd}
              onChange={(e) => setTargetUsd(e.target.value)}
              className="w-40 bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Horizon (hours)</label>
            <input
              type="number"
              value={horizonHours}
              min={1}
              onChange={(e) => setHorizonHours(Math.max(1, Number(e.target.value) || 24))}
              className="w-28 bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => load().catch(console.error)}
            className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90"
            disabled={loading}
          >
            {loading ? 'Computing...' : 'Estimate'}
          </button>
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}

        {data ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="bg-black/20 rounded-lg p-3">
                <div className="text-xs text-[var(--muted)]">Probability</div>
                <div className="font-mono font-bold text-lg">{formatPercentCeil(data.probability)}</div>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <div className="text-xs text-[var(--muted)]">Current MCap</div>
                <div className="font-mono">{formatUsd(data.currentMarketCapUsd)}</div>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <div className="text-xs text-[var(--muted)]">Target</div>
                <div className="font-mono">{formatUsd(data.targetMarketCapUsd)}</div>
              </div>
              <div className="bg-black/20 rounded-lg p-3">
                <div className="text-xs text-[var(--muted)]">Confidence</div>
                <div className="font-mono">{data.confidence}</div>
              </div>
            </div>
            <div className="text-xs text-[var(--muted)]">
              Model: <span className="font-mono text-white">{data.modelVersion}</span>
              {' | '}
              TrainedAt: <span className="font-mono text-white">{new Date(data.trainedAt).toLocaleString()}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                    <th className="text-left p-2">Factor</th>
                    <th className="text-right p-2">Value</th>
                    <th className="text-right p-2">Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.factors.map((f) => (
                    <tr key={f.name} className="border-b border-[var(--card-border)]">
                      <td className="p-2 font-mono">{f.name}</td>
                      <td className="p-2 text-right font-mono">{f.value.toFixed(4)}</td>
                      <td className="p-2 text-right font-mono">{f.contribution.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
