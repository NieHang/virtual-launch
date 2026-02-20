import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'
import { computeThresholdProbability } from '../src/metrics/threshold-probability.js'
import { config } from '../src/config.js'

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

async function main() {
  const horizonHours = config.probabilityModelWindowHours
  const targets = config.probabilityModelDefaultTargetsUsd
  const nowTs = Math.floor(Date.now() / 1000)
  const windowTs = nowTs - horizonHours * 3600

  const projects = db.select().from(schema.projects).all()
  const rows: Array<{
    projectId: string
    targetUsd: number
    probability: number
    realizedHit: boolean
  }> = []

  for (const p of projects) {
    const trades = db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.projectId, p.id))
      .all()
      .filter((t) => t.ts >= windowTs)

    if (trades.length < config.probabilityModelMinSamples) continue

    const lastPrice = trades
      .filter((t) => t.priceQuotePerToken && t.priceQuotePerToken > 0)
      .sort((a, b) => b.ts - a.ts)[0]?.priceQuotePerToken || null
    const maxPrice = trades
      .filter((t) => t.priceQuotePerToken && t.priceQuotePerToken > 0)
      .reduce((acc, t) => Math.max(acc, t.priceQuotePerToken || 0), 0)

    const totalSupply = p.totalSupply ? Number(BigInt(p.totalSupply)) / 1e18 : 1_000_000_000
    const currentMcap = lastPrice ? lastPrice * totalSupply : null
    const peakMcap = maxPrice > 0 ? maxPrice * totalSupply : 0

    const buys = trades
      .filter((t) => t.side === 'BUY')
      .reduce((acc, t) => acc + BigInt(t.quoteInGross || t.quoteIn || '0'), 0n)
    const sells = trades
      .filter((t) => t.side === 'SELL')
      .reduce((acc, t) => acc + BigInt(t.quoteOut || '0'), 0n)
    const denom = buys + sells
    const momentum = denom > 0n ? Number(buys - sells) / Number(denom) : 0

    const concentrationTop10 = 0.5
    const buyTaxRate = p.buyTaxBps ? p.buyTaxBps / 10000 : 0.01

    for (const target of targets) {
      const pred = computeThresholdProbability({
        targetMarketCapUsd: target,
        currentMarketCapUsd: currentMcap,
        remainingBuybackUsd: 0,
        buyTaxRate,
        concentrationTop10,
        buyMomentum: clamp01(momentum),
        sampleTrades: trades.length,
        horizonHours,
      })
      rows.push({
        projectId: p.id,
        targetUsd: target,
        probability: pred.probability,
        realizedHit: peakMcap >= target,
      })
    }
  }

  if (rows.length === 0) {
    console.log(JSON.stringify({ rows: 0, note: 'not enough samples' }, null, 2))
    return
  }

  const brier =
    rows.reduce((acc, r) => acc + Math.pow(r.probability - (r.realizedHit ? 1 : 0), 2), 0) /
    rows.length

  console.log(
    JSON.stringify(
      {
        modelVersion: 'threshold-v1.0-baseline',
        evaluatedAt: new Date().toISOString(),
        horizonHours,
        samples: rows.length,
        brierScore: brier,
        rows,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
