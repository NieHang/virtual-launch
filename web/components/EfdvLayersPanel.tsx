'use client'

import { useEffect, useState } from 'react'
import { api, type EfdvLayerResponse } from '@/lib/api'
import { formatPercentCeil, formatPrice, formatUsd } from '@/lib/format'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
}

export function EfdvLayersPanel({ projectId, virtualUsdPrice }: Props) {
  const [mode, setMode] = useState<'prelaunch' | 'live'>('prelaunch')
  const [baseFdvInput, setBaseFdvInput] = useState('42000')
  const [prebuyPctInput, setPrebuyPctInput] = useState('0')
  const [data, setData] = useState<EfdvLayerResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const DEFAULT_BASE_FDV_V = 42_000
  const hasUsd =
    virtualUsdPrice !== null &&
    virtualUsdPrice !== undefined &&
    virtualUsdPrice > 0
  const parsedBaseFdv = Number(baseFdvInput)
  const baseFdvVirtual =
    Number.isFinite(parsedBaseFdv) && parsedBaseFdv > 0
      ? parsedBaseFdv
      : DEFAULT_BASE_FDV_V
  const parsedPrebuyPct = Number(prebuyPctInput)
  const normalizedPrebuyPct = Number.isFinite(parsedPrebuyPct)
    ? Math.min(Math.max(parsedPrebuyPct, 0), 99)
    : 0
  const prebuyRatio = normalizedPrebuyPct / 100

  useEffect(() => {
    setLoading(true)
    setError(null)
    api
      .getEfdvLayers(
        projectId,
        mode,
        prebuyRatio,
        mode === 'prelaunch' ? baseFdvVirtual : undefined,
      )
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [projectId, mode, prebuyRatio, baseFdvVirtual])

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)] flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-semibold">EFDV Layers (Prelaunch)</h3>
          <p className="text-xs text-[var(--muted)] mt-1">
            Layer-by-layer breakeven valuation by tax decay curve
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--muted)]" htmlFor="efdv-base-fdv">
            Base FDV (V)
          </label>
          <input
            id="efdv-base-fdv"
            type="number"
            min={1}
            step={100}
            value={baseFdvInput}
            onChange={(e) => setBaseFdvInput(e.target.value)}
            className="w-28 bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-xs font-mono"
          />
          <label
            className="text-xs text-[var(--muted)]"
            htmlFor="efdv-prebuy-pct"
          >
            Pre-buy %
          </label>
          <input
            id="efdv-prebuy-pct"
            type="number"
            min={0}
            max={99}
            step={0.1}
            value={prebuyPctInput}
            onChange={(e) => setPrebuyPctInput(e.target.value)}
            className="w-24 bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-xs font-mono"
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'prelaunch' | 'live')}
            className="bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-xs"
          >
            <option value="prelaunch">Prelaunch</option>
            <option value="live">Live</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-sm text-[var(--muted)]">
          Loading EFDV layers...
        </div>
      ) : error ? (
        <div className="p-6 text-sm text-red-400">{error}</div>
      ) : !data ? (
        <div className="p-6 text-sm text-[var(--muted)]">No data</div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="text-xs text-[var(--muted)] flex flex-wrap gap-4">
            <span>
              Price source:{' '}
              <span className="text-white font-mono">{data.priceSource}</span>
            </span>
            <span>
              Base FDV:
              <span className="text-white font-mono ml-1">
                {baseFdvVirtual.toFixed(2)} V
              </span>
            </span>
            <span>
              Base price:
              <span className="text-white font-mono ml-1">
                {hasUsd
                  ? `${formatUsd(data.basePrice * virtualUsdPrice!)} (${formatPrice(data.basePrice)} V)`
                  : `${formatPrice(data.basePrice)} V`}
              </span>
            </span>
            <span>
              Tax model:{' '}
              <span className="text-white font-mono">{data.taxModel}</span>
            </span>
            <span>
              Prebuy multiplier:
              <span className="text-white font-mono ml-1">
                {data.prebuyMultiplier.toFixed(4)}x
              </span>
            </span>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Formula: FDV = baseFDV x 1 / (1 - prebuyRatio), EFDV = FDV / (1 -
            tax). Current prebuy ratio:
            <span className="text-white font-mono ml-1">
              {(data.prebuyRatio * 100).toFixed(2)}%
            </span>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                  <th className="text-left p-2">Tax Layer</th>
                  <th className="text-right p-2">FDV</th>
                  <th className="text-right p-2">EFDV</th>
                  <th className="text-right p-2">Breakeven</th>
                </tr>
              </thead>
              <tbody>
                {data.layers.map((r) => (
                  <tr
                    key={r.taxRate}
                    className="border-b border-[var(--card-border)]"
                  >
                    <td className="p-2 font-mono">
                      {formatPercentCeil(r.taxRate)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {hasUsd
                        ? formatUsd(r.impliedFdv * virtualUsdPrice!)
                        : `${r.impliedFdv.toFixed(2)} V`}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {hasUsd
                        ? formatUsd(r.impliedEfdv * virtualUsdPrice!)
                        : `${r.impliedEfdv.toFixed(2)} V`}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {r.breakevenMultiple.toFixed(2)}x
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

