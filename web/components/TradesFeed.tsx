'use client'

import { useEffect, useState } from 'react'
import { api, type Trade } from '@/lib/api'
import { useWebSocket } from '@/lib/ws'
import {
  formatWei,
  formatPrice,
  formatTime,
  formatUsd,
  weiToNumber,
  shortenAddress,
} from '@/lib/format'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
}

export function TradesFeed({ projectId, virtualUsdPrice }: Props) {
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [venueFilter, setVenueFilter] = useState<string>('')
  const { lastEvent } = useWebSocket(projectId)

  useEffect(() => {
    api
      .getTrades(projectId, 100, venueFilter || undefined)
      .then((data) => setTrades(data.trades))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [projectId, venueFilter])

  // Add new trades from WebSocket
  useEffect(() => {
    if (lastEvent?.type === 'trade' && lastEvent.trade) {
      setTrades((prev) => {
        const newTrade = lastEvent.trade as Trade
        // Filter by venue if active
        if (venueFilter && newTrade.venue !== venueFilter) return prev
        // Deduplicate
        if (
          prev.some((t) => t.txHash === newTrade.txHash && t.id === newTrade.id)
        )
          return prev
        return [newTrade, ...prev].slice(0, 200)
      })
    }
  }, [lastEvent, venueFilter])

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-[var(--card-border)]">
        <h3 className="font-semibold">Recent Trades</h3>
        <div className="flex gap-1">
          {['', 'INTERNAL', 'EXTERNAL'].map((v) => (
            <button
              key={v}
              onClick={() => setVenueFilter(v)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                venueFilter === v
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-black/20 text-[var(--muted)] hover:text-white'
              }`}
            >
              {v || 'All'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-[var(--muted)]">
          Loading trades...
        </div>
      ) : trades.length === 0 ? (
        <div className="p-8 text-center text-[var(--muted)]">No trades yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] uppercase border-b border-[var(--card-border)]">
                <th className="text-left p-3">Time</th>
                <th className="text-left p-3">Side</th>
                <th className="text-left p-3">Venue</th>
                <th className="text-right p-3">Amount{hasUsd ? ' (USD)' : ' (V)'}</th>
                <th className="text-right p-3">Tokens</th>
                <th className="text-right p-3">Price{hasUsd ? ' (USD)' : ' (V)'}</th>
                <th className="text-left p-3">Trader</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade, i) => {
                const rawQuote = trade.side === 'BUY' ? trade.quoteIn : trade.quoteOut
                const rawTokens = trade.side === 'BUY' ? trade.tokenOut : trade.tokenIn
                const quoteNum = weiToNumber(rawQuote, 18)
                const priceV = trade.priceQuotePerToken

                return (
                  <tr
                    key={`${trade.txHash}-${trade.id || i}`}
                    className="border-b border-[var(--card-border)] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="p-3 text-[var(--muted)] font-mono text-xs">
                      {formatTime(trade.ts)}
                    </td>
                    <td className="p-3">
                      <span
                        className={`font-bold ${
                          trade.side === 'BUY' ? 'text-buy' : 'text-sell'
                        }`}
                      >
                        {trade.side}
                      </span>
                    </td>
                    <td className="p-3">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          trade.venue === 'EXTERNAL'
                            ? 'bg-green-900/20 text-green-400'
                            : 'bg-yellow-900/20 text-yellow-400'
                        }`}
                      >
                        {trade.venue === 'EXTERNAL' ? 'EXT' : 'INT'}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono">
                      {hasUsd
                        ? formatUsd(quoteNum * virtualUsdPrice!)
                        : `${formatWei(rawQuote, 18, 2)} V`}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {formatWei(rawTokens, 18, 2)}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {priceV !== null && hasUsd
                        ? formatUsd(priceV * virtualUsdPrice!)
                        : formatPrice(priceV)}
                    </td>
                    <td className="p-3 font-mono text-xs text-[var(--muted)]">
                      <a
                        href={`https://basescan.org/address/${trade.trader}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--accent)] transition-colors"
                      >
                        {shortenAddress(trade.trader)}
                      </a>
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
