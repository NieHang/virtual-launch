'use client'

import { useEffect, useState } from 'react'
import { api, type WhaleEntry, type AddressDetail } from '@/lib/api'
import { formatPrice, formatUsd, formatTime, weiToNumber, shortenAddress } from '@/lib/format'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
}

function formatTokenAmount(weiStr: string): string {
  const num = weiToNumber(weiStr, 18)
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M'
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K'
  return num.toFixed(2)
}

function formatVirtualAmount(weiStr: string, hasUsd: boolean, virtualUsdPrice?: number | null): string {
  const num = weiToNumber(weiStr, 18)
  if (num <= 0) return '-'
  if (hasUsd && virtualUsdPrice) return formatUsd(num * virtualUsdPrice)
  return num.toFixed(2) + ' V'
}

export function WhaleTable({ projectId, virtualUsdPrice }: Props) {
  const [whales, setWhales] = useState<WhaleEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showTransferOnly, setShowTransferOnly] = useState(false)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const [detail, setDetail] = useState<AddressDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  const loadWhales = () =>
    api.getWhales(projectId, 20, showTransferOnly).then(setWhales)

  useEffect(() => {
    setLoading(true)
    api
      .getWhales(projectId, 20, showTransferOnly)
      .then(setWhales)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [projectId, showTransferOnly])

  useEffect(() => {
    if (!selectedAddress) return
    setDetailLoading(true)
    setDetailError(null)
    api
      .getAddressDetail(projectId, selectedAddress, 20)
      .then(setDetail)
      .catch((e) => setDetailError(e.message))
      .finally(() => setDetailLoading(false))
  }, [projectId, selectedAddress])

  useEffect(() => {
    const interval = setInterval(() => {
      loadWhales().catch(console.error)
    }, 30_000)
    return () => clearInterval(interval)
  }, [projectId, showTransferOnly])

  return (
    <>
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)]">
        <h3 className="font-semibold">Top Holders</h3>
        <p className="text-xs text-[var(--muted)] mt-1">
          Ranked by actual token balance. Cost/tax/PnL metrics are trade-based.
        </p>
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-[var(--muted)]">
          <input
            type="checkbox"
            checked={showTransferOnly}
            onChange={(e) => setShowTransferOnly(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Show transfer-only addresses
        </label>
      </div>

      {loading ? (
        <div className="p-8 text-center text-[var(--muted)]">Loading...</div>
      ) : whales.length === 0 ? (
        <div className="p-8 text-center text-[var(--muted)]">No data yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                <th className="text-left p-3">#</th>
                <th className="text-left p-3">Address</th>
                <th className="text-right p-3">Balance</th>
                <th className="text-right p-3">Gross Spent</th>
                <th className="text-right p-3">Tax Paid</th>
                <th className="text-right p-3">Open Avg Cost</th>
                <th className="text-right p-3">PnL</th>
              </tr>
            </thead>
            <tbody>
              {whales.map((whale, i) => {
                const grossNum = weiToNumber(whale.spentQuoteGross, 18)
                const taxNum = weiToNumber(whale.taxPaid, 18)
                const hasTax = taxNum > 0

                return (
                  <tr
                    key={whale.address}
                    className="border-b border-[var(--card-border)] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="p-3 text-[var(--muted)]">{i + 1}</td>
                    <td className="p-3 font-mono text-xs space-x-2">
                      <button
                        onClick={() => setSelectedAddress(whale.address)}
                        className="hover:text-[var(--accent)] transition-colors"
                      >
                        {shortenAddress(whale.address, 6)}
                      </button>
                      {whale.dataCompleteness === 'TRANSFER_ONLY' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-300">
                          Transfer-only
                        </span>
                      )}
                      <a
                        href={`https://basescan.org/address/${whale.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--muted)] hover:text-white"
                        title="Open in BaseScan"
                      >
                        ↗
                      </a>
                    </td>
                    <td className="p-3 text-right font-mono font-bold text-green-400">
                      {formatTokenAmount(whale.balance)}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {grossNum > 0
                        ? formatVirtualAmount(whale.spentQuoteGross, hasUsd, virtualUsdPrice)
                        : <span className="text-[var(--muted)]">{whale.dataCompleteness === 'TRANSFER_ONLY' ? 'Transfer-only' : '-'}</span>}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">
                      {hasTax ? (
                        <span className="text-red-400">
                          {formatVirtualAmount(whale.taxPaid, hasUsd, virtualUsdPrice)}
                        </span>
                      ) : (
                        <span className="text-[var(--muted)]">{whale.dataCompleteness === 'TRANSFER_ONLY' ? 'Transfer-only' : '-'}</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">
                      {whale.avgCostOpenGross !== null ? (
                        <span title={`Historical gross avg: ${formatPrice(whale.avgCostGross)} | Net open: ${formatPrice(whale.avgCostOpen)}`}>
                          {hasUsd
                            ? formatUsd(whale.avgCostOpenGross * virtualUsdPrice!)
                            : formatPrice(whale.avgCostOpenGross)}
                        </span>
                      ) : whale.avgCostOpen !== null ? (
                        <span>
                          {hasUsd
                            ? formatUsd(whale.avgCostOpen * virtualUsdPrice!)
                            : formatPrice(whale.avgCostOpen)}
                        </span>
                      ) : (
                        <span className="text-[var(--muted)]">{whale.dataCompleteness === 'TRANSFER_ONLY' ? 'Transfer-only' : '-'}</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">
                      {whale.realizedPnl !== null ? (
                        <span className={whale.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {whale.realizedPnl >= 0 ? '+' : ''}
                          {hasUsd
                            ? formatUsd(whale.realizedPnl * virtualUsdPrice!)
                            : whale.realizedPnl.toFixed(2) + ' V'}
                        </span>
                      ) : (
                        <span className="text-[var(--muted)]">{whale.dataCompleteness === 'TRANSFER_ONLY' ? 'Transfer-only' : '-'}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    {selectedAddress && (
      <div
        className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        onClick={() => setSelectedAddress(null)}
      >
        <div
          className="w-full max-w-4xl bg-[var(--card)] border border-[var(--card-border)] rounded-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-4 border-b border-[var(--card-border)] flex items-center justify-between">
            <div>
              <h4 className="font-semibold">Address Detail</h4>
              <p className="font-mono text-xs text-[var(--muted)] mt-1">{selectedAddress}</p>
            </div>
            <button
              className="text-[var(--muted)] hover:text-white"
              onClick={() => setSelectedAddress(null)}
            >
              Close
            </button>
          </div>
          <div className="p-4 space-y-4 max-h-[70vh] overflow-auto">
            {detailLoading ? (
              <div className="text-[var(--muted)]">Loading detail...</div>
            ) : detailError ? (
              <div className="text-red-400">{detailError}</div>
            ) : detail ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bg-black/20 rounded p-3">
                    <div className="text-xs text-[var(--muted)]">Balance</div>
                    <div className="font-mono">{formatTokenAmount(detail.balance)}</div>
                  </div>
                  <div className="bg-black/20 rounded p-3">
                    <div className="text-xs text-[var(--muted)]">Open Avg Cost</div>
                    <div className="font-mono">
                      {detail.cost.avgCostOpenGross !== null
                        ? hasUsd
                          ? formatUsd(detail.cost.avgCostOpenGross * virtualUsdPrice!)
                          : formatPrice(detail.cost.avgCostOpenGross)
                        : '-'}
                    </div>
                  </div>
                  <div className="bg-black/20 rounded p-3">
                    <div className="text-xs text-[var(--muted)]">Realized PnL</div>
                    <div className={`font-mono ${(detail.cost.realizedPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {detail.cost.realizedPnl !== null
                        ? hasUsd
                          ? formatUsd(detail.cost.realizedPnl * virtualUsdPrice!)
                          : `${detail.cost.realizedPnl.toFixed(2)} V`
                        : '-'}
                    </div>
                  </div>
                  <div className="bg-black/20 rounded p-3">
                    <div className="text-xs text-[var(--muted)]">Unrealized PnL</div>
                    <div className={`font-mono ${(detail.cost.unrealizedPnl || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {detail.cost.unrealizedPnl !== null
                        ? hasUsd
                          ? formatUsd(detail.cost.unrealizedPnl * virtualUsdPrice!)
                          : `${detail.cost.unrealizedPnl.toFixed(2)} V`
                        : '-'}
                    </div>
                  </div>
                </div>

                <div>
                  <h5 className="font-semibold mb-2">Recent Trades</h5>
                  {detail.recentTrades.length === 0 ? (
                    <div className="text-[var(--muted)] text-sm">No trades found.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-[var(--muted)] border-b border-[var(--card-border)]">
                            <th className="text-left p-2">Time</th>
                            <th className="text-left p-2">Side</th>
                            <th className="text-right p-2">Gross In</th>
                            <th className="text-right p-2">Token Out</th>
                            <th className="text-right p-2">Price</th>
                            <th className="text-left p-2">Tx</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.recentTrades.map((t) => (
                            <tr key={`${t.txHash}:${t.id}`} className="border-b border-[var(--card-border)]">
                              <td className="p-2">{formatTime(t.ts)}</td>
                              <td className={`p-2 ${t.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{t.side}</td>
                              <td className="p-2 text-right">
                                {t.quoteInGross ? formatVirtualAmount(t.quoteInGross, hasUsd, virtualUsdPrice) : '-'}
                              </td>
                              <td className="p-2 text-right">{t.tokenOut ? formatTokenAmount(t.tokenOut) : '-'}</td>
                              <td className="p-2 text-right">{formatPrice(t.priceQuotePerToken)}</td>
                              <td className="p-2 font-mono">
                                <a
                                  href={`https://basescan.org/tx/${t.txHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:text-[var(--accent)]"
                                >
                                  {shortenAddress(t.txHash, 6)}
                                </a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    )}
    </>
  )
}
