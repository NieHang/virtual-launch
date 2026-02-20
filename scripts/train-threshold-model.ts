import { db, schema } from '../src/db/index.js'
import { desc, eq } from 'drizzle-orm'
import { config } from '../src/config.js'

async function main() {
  const projects = db.select().from(schema.projects).all()
  const summary = []

  for (const p of projects) {
    const trades = db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.projectId, p.id))
      .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
      .limit(5_000)
      .all()

    const buys = trades.filter((t) => t.side === 'BUY').length
    const sells = trades.filter((t) => t.side === 'SELL').length
    const latestPrice = trades.find((t) => t.priceQuotePerToken && t.priceQuotePerToken > 0)?.priceQuotePerToken || null

    summary.push({
      projectId: p.id,
      name: p.name,
      samples: trades.length,
      buys,
      sells,
      latestPrice,
    })
  }

  const totalSamples = summary.reduce((acc, s) => acc + s.samples, 0)
  console.log(
    JSON.stringify(
      {
        modelVersion: 'threshold-v1.0-baseline',
        trainedAt: new Date().toISOString(),
        config: {
          windowHours: config.probabilityModelWindowHours,
          minSamples: config.probabilityModelMinSamples,
          defaultTargetsUsd: config.probabilityModelDefaultTargetsUsd,
        },
        projects: summary.length,
        totalSamples,
        perProject: summary,
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
