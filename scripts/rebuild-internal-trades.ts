import { type Address, getAddress } from 'viem'
import { and, asc, eq } from 'drizzle-orm'
import { pushSchema } from '../src/db/migrate.js'
import { db, schema } from '../src/db/index.js'
import { scanBlockRange } from '../src/indexer/block-scanner.js'
import { reconstructTrades } from '../src/indexer/trade-parser.js'
import { updateAddressCosts } from '../src/metrics/address-cost.js'
import type { Trade } from '../src/types.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.log(
      'Usage: tsx scripts/rebuild-internal-trades.ts <project_id> [from_block] [to_block]',
    )
    process.exit(1)
  }

  const projectId = args[0]
  pushSchema()

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get()
  if (!project) throw new Error(`Project not found: ${projectId}`)

  const internalMarket = db
    .select()
    .from(schema.markets)
    .where(
      and(
        eq(schema.markets.projectId, projectId),
        eq(schema.markets.venue, 'INTERNAL'),
      ),
    )
    .get()
  if (!internalMarket) throw new Error(`No INTERNAL market for project ${projectId}`)

  const fromBlock = args[1]
    ? parseInt(args[1], 10)
    : project.firstActiveBlock || 0
  const toBlock = args[2]
    ? parseInt(args[2], 10)
    : project.lastIndexedBlock || fromBlock

  const tokenAddress = getAddress(project.tokenAddress as Address)
  const marketAddress = getAddress(internalMarket.marketAddress as Address)
  console.log(
    `[rebuild-internal-trades] project=${projectId} market=${marketAddress} range=${fromBlock}-${toBlock}`,
  )

  // 1) Rebuild INTERNAL trades from scratch for this project.
  db.delete(schema.trades)
    .where(
      and(
        eq(schema.trades.projectId, projectId),
        eq(schema.trades.venue, 'INTERNAL'),
      ),
    )
    .run()

  const batchSize = 100
  let insertedInternal = 0
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock)
    const blockData = await scanBlockRange(tokenAddress, start, end, false)
    for (const block of blockData) {
      const trades = reconstructTrades(
        block.tokenTransfers,
        block.virtualTransfers,
        marketAddress,
        tokenAddress,
        projectId,
        'INTERNAL',
        block.timestamp,
      )
      for (const trade of trades) {
        try {
          db.insert(schema.trades).values(trade).onConflictDoNothing().run()
          insertedInternal += 1
        } catch {
          // non-fatal
        }
      }
    }
  }

  // 2) Recompute address costs from all project trades (INTERNAL + EXTERNAL).
  db.delete(schema.addressCosts)
    .where(eq(schema.addressCosts.projectId, projectId))
    .run()

  const allTrades = db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.projectId, projectId))
    .orderBy(asc(schema.trades.blockNumber), asc(schema.trades.logIndex))
    .all() as Trade[]

  updateAddressCosts(allTrades)

  console.log(
    `[rebuild-internal-trades] internalInserted=${insertedInternal}, costsRebuiltFromTrades=${allTrades.length}`,
  )
}

main().catch((err) => {
  console.error('[rebuild-internal-trades] failed:', err)
  process.exit(1)
})
