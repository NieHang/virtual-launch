'use client'

import { useEffect, useState } from 'react'
import { api, type InternalWhaleProfile } from '@/lib/api'
import { formatPercentCeil, formatPrice, formatUsd, formatWei, shortenAddress } from '@/lib/format'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
}

export function InternalWhaleProfilePanel({ projectId, virtualUsdPrice }: Props) {
  const [items, setItems] = useState<InternalWhaleProfile[]>([])
  const [loading, setLoading] = useState(true)
  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  useEffect(() => {
    api
      .getInternalWhales(projectId, 20, true)
      .then((res) => setItems(res.items))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [projectId])

  return (
    <div>
      {loading ? (
        <div className="p-8 text-center text-[var(--muted)]">Loading internal whales...</div>
      ) : items.length === 0 ? (
        <div className="p-8 text-center text-[var(--muted)]">No internal whale data</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                <th className="text-left p-3">Address</th>
                <th className="text-right p-3">Internal Buy</th>
                <th className="text-right p-3">External Buy</th>
                <th className="text-right p-3">All Buy</th>
                <th className="text-right p-3">Avg Tax</th>
                <th className="text-right p-3">Avg Cost</th>
                <th className="text-right p-3">PnL</th>
                <th className="text-right p-3">Share</th>
                <th className="text-right p-3">Wallet</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.address} className="border-b border-[var(--card-border)]">
                  <td className="p-3 font-mono text-xs">
                    <a
                      href={`https://basescan.org/address/${it.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-[var(--accent)]"
                    >
                      {shortenAddress(it.address, 6)}
                    </a>
                  </td>
                  <td className="p-3 text-right font-mono">
                    {hasUsd
                      ? formatUsd((Number(it.buyVolumeGross) / 1e18) * virtualUsdPrice!)
                      : `${formatWei(it.buyVolumeGross, 18, 2)} V`}
                  </td>
                  <td className="p-3 text-right font-mono">
                    {hasUsd
                      ? formatUsd((Number(it.externalBuyGross || '0') / 1e18) * virtualUsdPrice!)
                      : `${formatWei(it.externalBuyGross || '0', 18, 2)} V`}
                  </td>
                  <td className="p-3 text-right font-mono font-bold">
                    {hasUsd
                      ? formatUsd((Number(it.allVenueBuyGross || '0') / 1e18) * virtualUsdPrice!)
                      : `${formatWei(it.allVenueBuyGross || '0', 18, 2)} V`}
                  </td>
                  <td className="p-3 text-right font-mono" title={it.avgBuyTaxRateSource === 'ALL_BUYS' ? 'Fallback: all venues' : 'Internal only'}>
                    {it.avgBuyTaxRate !== null
                      ? `${(it.avgBuyTaxRate * 100).toFixed(0)}%${it.avgBuyTaxRateSource === 'ALL_BUYS' ? '*' : ''}`
                      : '-'}
                  </td>
                  <td className="p-3 text-right font-mono">
                    {it.avgCostGross !== null
                      ? hasUsd
                        ? formatUsd(it.avgCostGross * virtualUsdPrice!)
                        : formatPrice(it.avgCostGross)
                      : '-'}
                  </td>
                  <td className="p-3 text-right font-mono">
                    {it.realizedPnl !== null
                      ? it.realizedPnl >= 0
                        ? `+${hasUsd ? formatUsd(it.realizedPnl * virtualUsdPrice!) : `${it.realizedPnl.toFixed(2)} V`}`
                        : hasUsd
                          ? formatUsd(it.realizedPnl * virtualUsdPrice!)
                          : `${it.realizedPnl.toFixed(2)} V`
                      : '-'}
                  </td>
                  <td className="p-3 text-right font-mono">{formatPercentCeil(it.holdingShare)}</td>
                  <td className="p-3 text-right font-mono text-xs">
                    {it.totalValueUsd !== null && it.totalValueUsd !== undefined
                      ? formatUsd(it.totalValueUsd)
                      : it.wealthUnknown
                        ? '?'
                        : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-3 pb-2 text-xs text-[var(--muted)]">* Avg Tax with asterisk means fallback to all-venue average (no internal buys)</p>
    </div>
  )
}
