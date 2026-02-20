import { type Address, getAddress } from 'viem'
import { pushSchema } from '../src/db/migrate.js'
import { db, schema } from '../src/db/index.js'
import { getClient } from '../src/chain/client.js'
import { VIRTUAL_ADDRESS } from '../src/chain/constants.js'
import { fetchTransferLogs, parseTransferLogs } from '../src/chain/utils.js'
import { extractTaxInflows } from '../src/indexer/tax-tracker.js'
import { and, eq, gte, lte } from 'drizzle-orm'

interface Totals {
  virtual: bigint
  token: bigint
}

function addByToken(
  totals: Totals,
  tokenAddress: string,
  token: string,
  amount: bigint,
): void {
  const normalized = token.toLowerCase()
  if (normalized === VIRTUAL_ADDRESS.toLowerCase()) {
    totals.virtual += amount
  } else if (normalized === tokenAddress.toLowerCase()) {
    totals.token += amount
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.log('Usage: tsx scripts/verify-tax.ts <project_id> [from_block] [to_block]')
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

  const client = getClient()
  const latestBlock = Number(await client.getBlockNumber())
  const fromBlock = args[1]
    ? parseInt(args[1], 10)
    : project.firstActiveBlock || indexerState?.lastProcessedBlock || Math.max(0, latestBlock - 20_000)
  const toBlock = args[2]
    ? parseInt(args[2], 10)
    : project.lastIndexedBlock || indexerState?.lastProcessedBlock || latestBlock

  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock > toBlock) {
    throw new Error(`Invalid block range: ${fromBlock}-${toBlock}`)
  }

  console.log(`[verify-tax] project=${projectId} range=${fromBlock}-${toBlock}`)

  // Build DB snapshot in range (dedupe by txHash:logIndex)
  const dbInflows = db
    .select()
    .from(schema.taxInflows)
    .where(
      and(
        eq(schema.taxInflows.projectId, projectId),
        gte(schema.taxInflows.blockNumber, fromBlock),
        lte(schema.taxInflows.blockNumber, toBlock),
      ),
    )
    .all()
  const dbKeys = new Set<string>()
  const dbTotals: Totals = { virtual: 0n, token: 0n }
  for (const row of dbInflows) {
    const key = `${row.txHash}:${row.logIndex}`
    if (dbKeys.has(key)) continue
    dbKeys.add(key)
    addByToken(dbTotals, tokenAddress, row.token, BigInt(row.amount))
  }

  // Replay from chain logs in chunks
  const replayKeys = new Set<string>()
  const replayTotals: Totals = { virtual: 0n, token: 0n }
  const chunkSize = 2_000
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock)
    const [tokenLogs, virtualLogs] = await Promise.all([
      fetchTransferLogs(tokenAddress as Address, BigInt(start), BigInt(end)),
      fetchTransferLogs(VIRTUAL_ADDRESS as Address, BigInt(start), BigInt(end)),
    ])
    const inflows = extractTaxInflows(
      parseTransferLogs(tokenLogs),
      parseTransferLogs(virtualLogs),
      taxRecipient,
      projectId,
      0,
    )
    for (const inflow of inflows) {
      const key = `${inflow.txHash}:${inflow.logIndex}`
      if (replayKeys.has(key)) continue
      replayKeys.add(key)
      addByToken(replayTotals, tokenAddress, inflow.token, BigInt(inflow.amount))
    }
  }

  const missingInDb = [...replayKeys].filter((k) => !dbKeys.has(k))
  const extraInDb = [...dbKeys].filter((k) => !replayKeys.has(k))

  console.log('[verify-tax] ----- summary -----')
  console.log(`[verify-tax] db inflows (dedup): ${dbKeys.size}`)
  console.log(`[verify-tax] replay inflows (dedup): ${replayKeys.size}`)
  console.log(`[verify-tax] missing in db: ${missingInDb.length}`)
  console.log(`[verify-tax] extra in db: ${extraInDb.length}`)
  console.log(
    `[verify-tax] db totals: virtual=${dbTotals.virtual.toString()} token=${dbTotals.token.toString()}`,
  )
  console.log(
    `[verify-tax] replay totals: virtual=${replayTotals.virtual.toString()} token=${replayTotals.token.toString()}`,
  )
  console.log(
    `[verify-tax] delta totals: virtual=${(replayTotals.virtual - dbTotals.virtual).toString()} token=${(replayTotals.token - dbTotals.token).toString()}`,
  )

  if (missingInDb.length > 0) {
    console.log('[verify-tax] sample missing keys:', missingInDb.slice(0, 20))
  }
  if (extraInDb.length > 0) {
    console.log('[verify-tax] sample extra keys:', extraInDb.slice(0, 20))
  }
}

main().catch((err) => {
  console.error('[verify-tax] failed:', err)
  process.exit(1)
})
