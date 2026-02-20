'use client'

import { useEffect, useState } from 'react'
import { api, type WhaleAbsorptionResponse, type WhalePressureResponse } from '@/lib/api'
import { formatPercentCeil, formatUsd, formatWei, weiToNumber } from '@/lib/format'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
}

export function WhalePressure({ projectId, virtualUsdPrice }: Props) {
  const [pressure, setPressure] = useState<WhalePressureResponse | null>(null)
  const [absorption, setAbsorption] = useState<WhaleAbsorptionResponse | null>(null)
  const [sellShare, setSellShare] = useState(0.25)
  const [topN, setTopN] = useState(20)
  const [mode, setMode] = useState<'IDEAL' | 'CONSERVATIVE'>('IDEAL')
  const [loading, setLoading] = useState(true)

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  const load = async () => {
    setLoading(true)
    try {
      const [p, a] = await Promise.all([
        api.getWhalePressure(projectId, true),
        api.getWhaleAbsorption(projectId, { sellShare, topN, mode, onlyEoa: true }),
      ])
      setPressure(p)
      setAbsorption(a)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return (
    <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Sell share</label>
            <input
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              value={sellShare}
              onChange={(e) => setSellShare(Math.min(1, Math.max(0.01, Number(e.target.value) || 0.25)))}
              className="w-28 bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Top N</label>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={topN}
              onChange={(e) => setTopN(Math.max(1, Math.min(100, Number(e.target.value) || 20)))}
              className="w-24 bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'IDEAL' | 'CONSERVATIVE')}
              className="bg-black/30 border border-[var(--card-border)] rounded-md px-2 py-1 text-sm"
            >
              <option value="IDEAL">IDEAL</option>
              <option value="CONSERVATIVE">CONSERVATIVE</option>
            </select>
          </div>
          <button
            onClick={load}
            className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90"
          >
            Recalculate
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-[var(--muted)]">Loading pressure model...</div>
        ) : (
          <>
            {pressure && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {pressure.summaries.map((s) => (
                  <div key={s.topN} className="bg-black/20 rounded-lg p-3">
                    <div className="text-xs text-[var(--muted)]">Top {s.topN} Held Share</div>
                    <div className="font-mono font-bold text-lg">{formatPercentCeil(s.heldShare)}</div>
                    <div className="text-xs text-[var(--muted)] mt-1">
                      Held {formatWei(s.totalHeld, 18, 2)} / Supply {formatWei(s.totalSupply, 18, 2)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {pressure && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                      <th className="text-left p-2">Tier</th>
                      <th className="text-right p-2">Sell Amount (Token)</th>
                      <th className="text-right p-2">Est. Notional</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pressure.tiers.map((t) => (
                      <tr key={t.sellShareOfHeld} className="border-b border-[var(--card-border)]">
                        <td className="p-2">{Math.round(t.sellShareOfHeld * 100)}% of top-held</td>
                        <td className="p-2 text-right font-mono">{formatWei(t.sellAmountToken, 18, 2)}</td>
                        <td className="p-2 text-right font-mono">
                          {t.estimatedNotionalV !== null
                            ? hasUsd
                              ? formatUsd(t.estimatedNotionalV * virtualUsdPrice!)
                              : `${t.estimatedNotionalV.toFixed(2)} V`
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {absorption && (
              <div className="bg-black/20 rounded-lg p-3">
                <div className="text-xs text-[var(--muted)] mb-2">Absorption Decision</div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <span>
                    Remaining Tax: <span className="font-mono text-emerald-400">{formatWei(absorption.remainingTaxVirtual, 18, 2)} V</span>
                  </span>
                  <span>
                    Required: <span className="font-mono">{formatWei(absorption.requiredBuybackVirtual, 18, 2)} V</span>
                  </span>
                  <span>
                    Coverage: <span className="font-mono">{absorption.coverageRatio !== null ? `${(absorption.coverageRatio * 100).toFixed(1)}%` : '-'}</span>
                  </span>
                  <span className={absorption.canAbsorb ? 'text-green-400' : 'text-red-400'}>
                    {absorption.canAbsorb ? 'Can absorb' : 'Cannot absorb'}
                  </span>
                </div>
                <div className="text-xs text-[var(--muted)] mt-2">
                  Dump impact: {absorption.simulation.priceImpactPercent.toFixed(2)}%
                  {' | '}
                  Virtual out from dump: {formatWei(absorption.simulation.virtualOut, 18, 2)} V
                  {' | '}
                  Sell amount: {formatWei(absorption.simulation.sellAmountToken, 18, 2)} TKN
                </div>
              </div>
            )}
          </>
        )}
    </div>
  )
}
