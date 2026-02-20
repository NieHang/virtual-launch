'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, type WhaleActivityEntry, type WhaleEntry } from '@/lib/api'
import { formatTime, formatWei, formatUsd, shortenAddress, weiToNumber } from '@/lib/format'
import type { WsEvent } from '@/lib/ws'

interface Props {
  projectId: string
  virtualUsdPrice?: number | null
  lastEvent: WsEvent | null
}

interface AlertItem {
  ts: number
  address: string
  side: 'BUY' | 'SELL'
  quoteIn: string
}

const GLOBAL_EXCLUDED_BUYBACK = '0x32487287c65f11d53bbca89c2472171eb09bf337'
const ADDRESS_ACTIVITY_PAGE_SIZE = 200
const ADDRESS_ACTIVITY_MAX_FETCH = 600
const WHALE_ACTIVITY_THRESHOLD_WEI = '1000000000000000000000' // 1000 V

function alertToEntry(a: AlertItem): WhaleActivityEntry {
  return {
    txHash: `live-${a.ts}-${a.address}`,
    blockNumber: 0,
    ts: a.ts,
    venue: 'INTERNAL',
    address: a.address,
    side: a.side,
    action: a.side === 'BUY' ? 'ADD' : 'REDUCE',
    quoteGross: a.quoteIn,
    quoteNet: a.quoteIn,
    tokenAmount: '0',
    taxRate: null,
    baselineAvgCostGross: null,
    realizedPnlEstimate: null,
  }
}

function computeStats(rows: WhaleActivityEntry[]): {
  buyCostGross: bigint
  avgBuyTaxRate: number | null
  realizedPnl: number
} {
  let buyCostGross = BigInt(0)
  let buyGrossWeightSum = BigInt(0)
  let buyTaxWeight = 0
  let realizedPnl = 0

  for (const row of rows) {
    if (row.side === 'BUY') {
      const gross = BigInt(row.quoteGross || '0')
      buyCostGross += gross
      buyGrossWeightSum += gross
      if (row.taxRate !== null) {
        buyTaxWeight += Number(gross) * row.taxRate
      }
    }
    if (row.realizedPnlEstimate !== null) {
      realizedPnl += row.realizedPnlEstimate
    }
  }

  const avgBuyTaxRate =
    buyGrossWeightSum > BigInt(0)
      ? buyTaxWeight / Number(buyGrossWeightSum)
      : null

  return { buyCostGross, avgBuyTaxRate, realizedPnl }
}

export function WhaleActivityPanel({ projectId, virtualUsdPrice, lastEvent }: Props) {
  const [items, setItems] = useState<WhaleActivityEntry[]>([])
  const [whales, setWhales] = useState<WhaleEntry[]>([])
  const [addressEntriesMap, setAddressEntriesMap] = useState<Record<string, WhaleActivityEntry[]>>({})
  const [loading, setLoading] = useState(true)
  const [alerts, setAlerts] = useState<AlertItem[]>([])

  const hasUsd = virtualUsdPrice != null && virtualUsdPrice > 0

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getWhaleActivity(projectId, 60, 0, WHALE_ACTIVITY_THRESHOLD_WEI, true),
      api.getWhales(projectId, 200, false, true),
    ])
      .then(([activity, holders]) => {
        setItems(activity.items)
        setWhales(holders)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => {
    setAddressEntriesMap({})
  }, [projectId])

  const allowedAddresses = useMemo(
    () => new Set(whales.map((w) => w.address.toLowerCase())),
    [whales],
  )

  useEffect(() => {
    if (lastEvent?.type !== 'whale_alert') return
    const addr = (lastEvent.address || '').toLowerCase()
    if (!addr || addr === GLOBAL_EXCLUDED_BUYBACK) return
    if (!allowedAddresses.has(addr)) return
    const alert: AlertItem = {
      ts: Math.floor(Date.now() / 1000),
      address: lastEvent.address || '',
      side: lastEvent.side || 'BUY',
      quoteIn: lastEvent.quoteIn || '0',
    }
    setAlerts((prev) => [alert, ...prev].slice(0, 20))
  }, [lastEvent, allowedAddresses])

  const merged = useMemo(() => {
    return [...items].sort((a, b) => b.ts - a.ts).slice(0, 60)
  }, [items])

  const grouped = useMemo(() => {
    const byAddress = new Map<string, { address: string; fallbackEntries: WhaleActivityEntry[] }>()

    for (const row of merged) {
      const key = row.address.toLowerCase()
      const current = byAddress.get(key) || {
        address: row.address,
        fallbackEntries: [],
      }
      current.fallbackEntries.push(row)
      byAddress.set(key, current)
    }

    const holderMap = new Map(whales.map((w) => [w.address.toLowerCase(), w]))
    const cards = [...byAddress.values()].map((g) => {
      const holder = holderMap.get(g.address.toLowerCase())
      return {
        ...g,
        holdingAmount: holder?.balance || '0',
      }
    })

    // Filter out addresses with zero holding (cleared positions)
    return cards
      .filter((c) => BigInt(c.holdingAmount) > BigInt(0))
      .sort((a, b) => {
        const aHold = BigInt(a.holdingAmount)
        const bHold = BigInt(b.holdingAmount)
        if (bHold > aHold) return 1
        if (bHold < aHold) return -1
        return 0
      })
  }, [merged, whales])

  useEffect(() => {
    if (grouped.length === 0) return
    const targets = grouped
      .map((c) => c.address.toLowerCase())
      .filter((addr) => addressEntriesMap[addr] === undefined)
    if (targets.length === 0) return

    let cancelled = false
    Promise.all(
      targets.map(async (addr) => {
        const collected: WhaleActivityEntry[] = []
        let offset = 0
        let total = 0
        do {
          const res = await api.getWhaleActivityByAddress(
            projectId,
            addr,
            ADDRESS_ACTIVITY_PAGE_SIZE,
            offset,
            WHALE_ACTIVITY_THRESHOLD_WEI,
            true,
            false,
          )
          total = res.total
          collected.push(...res.items)
          offset += res.items.length
          if (res.items.length === 0) break
        } while (offset < total && offset < ADDRESS_ACTIVITY_MAX_FETCH)

        return [addr, collected.sort((a, b) => b.ts - a.ts)] as const
      }),
    )
      .then((result) => {
        if (cancelled) return
        setAddressEntriesMap((prev) => {
          const next = { ...prev }
          for (const [addr, rows] of result) {
            next[addr] = rows
          }
          return next
        })
      })
      .catch(console.error)

    return () => {
      cancelled = true
    }
  }, [grouped, projectId, addressEntriesMap])

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[var(--card-border)]">
        <h3 className="font-semibold">Whale Live Activity</h3>
        <p className="text-xs text-[var(--muted)] mt-1">
          Real-time whale add/reduce flow (from stream + historical scan)
        </p>
      </div>

      {loading ? (
        <div className="p-8 text-center text-[var(--muted)]">Loading whale activity...</div>
      ) : grouped.length === 0 ? (
        <div className="p-8 text-center text-[var(--muted)]">No whale activity yet</div>
      ) : (
        <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
          {grouped.map((card) => (
            <div key={card.address} className="bg-black/20 border border-[var(--card-border)] rounded-lg p-3">
              {(() => {
                const key = card.address.toLowerCase()
                const historicalEntries = addressEntriesMap[key] ?? card.fallbackEntries
                const liveEntries = alerts
                  .filter((a) => a.address.toLowerCase() === key)
                  .map(alertToEntry)
                const displayEntries = [...liveEntries, ...historicalEntries]
                  .sort((a, b) => b.ts - a.ts)
                  .slice(0, 5)
                const stats = computeStats(historicalEntries)
                const totalEvents = historicalEntries.length + liveEntries.length

                return (
                  <>
              <div className="flex items-center justify-between gap-2">
                <a
                  href={`https://basescan.org/address/${card.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs hover:text-[var(--accent)]"
                >
                  {shortenAddress(card.address, 6)}
                </a>
                <span className="text-xs text-[var(--muted)]">
                  {totalEvents} events
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                <div>
                  <div className="text-[var(--muted)]">Buy Cost</div>
                  <div className="font-mono">
                    {hasUsd
                      ? formatUsd(weiToNumber(stats.buyCostGross.toString()) * virtualUsdPrice!)
                      : `${formatWei(stats.buyCostGross.toString(), 18, 2)} V`}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Avg Buy Tax</div>
                  <div className="font-mono">
                    {stats.avgBuyTaxRate !== null ? `${(stats.avgBuyTaxRate * 100).toFixed(0)}%` : '-'}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Holding</div>
                  <div className="font-mono">{formatWei(card.holdingAmount, 18, 2)} TKN</div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Realized PnL</div>
                  <div className={`font-mono ${stats.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {stats.realizedPnl === 0
                      ? '-'
                      : hasUsd
                        ? formatUsd(stats.realizedPnl * virtualUsdPrice!)
                        : `${stats.realizedPnl.toFixed(2)} V`}
                  </div>
                </div>
              </div>

              <div className="mt-3 border-t border-[var(--card-border)] pt-2 space-y-1">
                {displayEntries.map((it) => (
                  <div key={`${it.txHash}-${it.ts}`} className="flex items-center justify-between text-xs">
                    <span className="text-[var(--muted)]">{formatTime(it.ts)}</span>
                    <span className={it.action === 'ADD' ? 'text-green-400' : 'text-red-400'}>
                      {it.action}
                    </span>
                    <span className="font-mono">
                      {hasUsd
                        ? formatUsd(weiToNumber(it.quoteGross) * virtualUsdPrice!)
                        : `${formatWei(it.quoteGross, 18, 2)} V`}
                    </span>
                  </div>
                ))}
              </div>
                  </>
                )
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
