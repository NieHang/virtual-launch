'use client'

import { useEffect, useState } from 'react'
import { api, type LargeOrder } from '@/lib/api'
import { formatUsd, weiToNumber, shortenAddress } from '@/lib/format'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
}

function formatVAmount(weiStr: string, hasUsd: boolean, vPrice?: number | null): string {
  const num = weiToNumber(weiStr, 18)
  if (hasUsd && vPrice) return formatUsd(num * vPrice)
  return num.toFixed(2) + ' V'
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function LargeOrders({ projectId, virtualUsdPrice }: Props) {
  const [orders, setOrders] = useState<LargeOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [threshold, setThreshold] = useState(100) // Default 100V

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  const fetchOrders = () => {
    api
      .getLargeOrders(projectId, threshold, 30)
      .then((res) => setOrders(res.orders))
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setLoading(true)
    fetchOrders()
  }, [projectId, threshold])

  useEffect(() => {
    const interval = setInterval(fetchOrders, 30_000)
    return () => clearInterval(interval)
  }, [projectId, threshold])

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)] flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Large Buy Orders</h3>
          <p className="text-xs text-[var(--muted)] mt-1">
            Gross amount (user&apos;s actual outlay, before tax deduction)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--muted)]">Min:</label>
          <select
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="bg-black/40 border border-[var(--card-border)] rounded px-2 py-1 text-xs"
          >
            <option value={50}>50 V</option>
            <option value={100}>100 V</option>
            <option value={500}>500 V</option>
            <option value={1000}>1,000 V</option>
            <option value={5000}>5,000 V</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-[var(--muted)]">Loading...</div>
      ) : orders.length === 0 ? (
        <div className="p-8 text-center text-[var(--muted)]">
          No orders above {threshold} V found
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                <th className="text-left p-3">Time</th>
                <th className="text-left p-3">Trader</th>
                <th className="text-right p-3">Gross Paid</th>
                <th className="text-right p-3">Net (Market)</th>
                <th className="text-right p-3">Tax</th>
                <th className="text-right p-3">Tokens</th>
                <th className="text-right p-3">Price (Gross)</th>
                <th className="text-left p-3">Venue</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const grossNum = weiToNumber(order.quoteInGross, 18)
                const netNum = weiToNumber(order.quoteInNet, 18)
                const taxNum = weiToNumber(order.taxPaid, 18)
                const tokensNum = order.tokenOut ? weiToNumber(order.tokenOut, 18) : 0
                const taxPct = (order.taxRate * 100).toFixed(0)

                return (
                  <tr
                    key={`${order.txHash}-${order.blockNumber}`}
                    className="border-b border-[var(--card-border)] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="p-3 text-[var(--muted)] text-xs whitespace-nowrap">
                      {timeAgo(order.ts)}
                    </td>
                    <td className="p-3 font-mono text-xs">
                      <a
                        href={`https://basescan.org/address/${order.trader}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--accent)] transition-colors"
                      >
                        {shortenAddress(order.trader, 6)}
                      </a>
                    </td>
                    <td className="p-3 text-right font-mono font-bold">
                      {formatVAmount(order.quoteInGross, hasUsd, virtualUsdPrice)}
                    </td>
                    <td className="p-3 text-right font-mono text-xs text-[var(--muted)]">
                      {formatVAmount(order.quoteInNet, hasUsd, virtualUsdPrice)}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">
                      {taxNum > 0 ? (
                        <span className="text-red-400">
                          {taxPct}%
                          <span className="ml-1 text-[var(--muted)]">
                            ({formatVAmount(order.taxPaid, hasUsd, virtualUsdPrice)})
                          </span>
                        </span>
                      ) : (
                        <span className="text-green-400">0%</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono text-xs text-green-400">
                      {tokensNum > 1000
                        ? (tokensNum / 1000).toFixed(1) + 'K'
                        : tokensNum.toFixed(0)}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">
                      {order.priceGross !== null ? (
                        <span title={`Net price: ${order.priceNet?.toExponential(4)}`}>
                          {hasUsd && virtualUsdPrice
                            ? formatUsd(order.priceGross * virtualUsdPrice)
                            : order.priceGross.toExponential(3)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="p-3 text-xs">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        order.venue === 'INTERNAL'
                          ? 'bg-yellow-400/20 text-yellow-400'
                          : 'bg-green-400/20 text-green-400'
                      }`}>
                        {order.venue === 'INTERNAL' ? 'Internal' : 'DEX'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
