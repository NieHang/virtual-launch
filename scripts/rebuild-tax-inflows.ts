import { type Address, getAddress } from 'viem'
import { and, eq, gte, lte } from 'drizzle-orm'
import { pushSchema } from '../src/db/migrate.js'
import { db, schema } from '../src/db/index.js'
import { getClient } from '../src/chain/client.js'
import { VIRTUAL_ADDRESS } from '../src/chain/constants.js'
import { fetchTransferLogs, parseTransferLogs } from '../src/chain/utils.js'
import { extractTaxInflows } from '../src/indexer/tax-tracker.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.log(
      'Usage: tsx scripts/rebuild-tax-inflows.ts <project_id> [from_block] [to_block]',
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
  if (!project.taxRecipient) throw new Error(`Project ${projectId} has no taxRecipient`)

  const tokenAddress = getAddress(project.tokenAddress as Address)
  const taxRecipient = getAddress(project.taxRecipient as Address)

  const indexerState = db
    .select()
    .from(schema.indexerState)
    .where(eq(schema.indexerState.projectId, projectId))
    .get()
  const latestBlock = Number(await getClient().getBlockNumber())

  const fromBlock = args[1]
    ? parseInt(args[1], 10)
    : project.firstActiveBlock ||
      indexerState?.lastProcessedBlock ||
      Math.max(0, latestBlock - 20_000)
  const toBlock = args[2]
    ? parseInt(args[2], 10)
    : project.lastIndexedBlock || indexerState?.lastProcessedBlock || latestBlock

  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock > toBlock) {
    throw new Error(`Invalid block range: ${fromBlock}-${toBlock}`)
  }

  console.log(
    `[rebuild-tax-inflows] project=${projectId} recipient=${taxRecipient} range=${fromBlock}-${toBlock}`,
  )

  // Remove existing rows in range, then replay with current extraction rules.
  db.delete(schema.taxInflows)
    .where(
      and(
        eq(schema.taxInflows.projectId, projectId),
        gte(schema.taxInflows.blockNumber, fromBlock),
        lte(schema.taxInflows.blockNumber, toBlock),
      ),
    )
    .run()

  const chunkSize = 2_000
  let inserted = 0
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock)
    const [tokenLogs, virtualLogs] = await Promise.all([
      fetchTransferLogs(tokenAddress as Address, BigInt(start), BigInt(end)),
      fetchTransferLogs(VIRTUAL_ADDRESS as Address, BigInt(start), BigInt(end)),
    ])

    const tokenTransfers = parseTransferLogs(tokenLogs)
    const virtualTransfers = parseTransferLogs(virtualLogs)
    const inflows = extractTaxInflows(
      tokenTransfers,
      virtualTransfers,
      taxRecipient,
      projectId,
      0,
    )

    const blockTsByNumber = new Map<number, number>()
    for (const inflow of inflows) {
      let ts = blockTsByNumber.get(inflow.blockNumber)
      if (!ts) {
        try {
          const b = await getClient().getBlock({
            blockNumber: BigInt(inflow.blockNumber),
          })
          ts = Number(b.timestamp)
        } catch {
          ts = Math.floor(Date.now() / 1000)
        }
        blockTsByNumber.set(inflow.blockNumber, ts)
      }
      try {
        db.insert(schema.taxInflows)
          .values({ ...inflow, ts })
          .onConflictDoNothing()
          .run()
        inserted += 1
      } catch {
        // non-fatal
      }
    }

    console.log(
      `[rebuild-tax-inflows] chunk ${start}-${end}: inflows=${inflows.length}, inserted=${inserted}`,
    )
  }

  console.log(`[rebuild-tax-inflows] done, inserted=${inserted}`)
}

main().catch((err) => {
  console.error('[rebuild-tax-inflows] failed:', err)
  process.exit(1)
})
