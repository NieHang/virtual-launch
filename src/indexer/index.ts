import { type Address, getAddress } from 'viem'
import { getClient } from '../chain/client.js'
import { TOKEN_ABI, VIRTUAL_ADDRESS } from '../chain/constants.js'
import { db, schema } from '../db/index.js'
import { eq, and, desc } from 'drizzle-orm'
import { config } from '../config.js'
import { sleep } from '../chain/utils.js'

import { findFirstActiveBlock } from './first-block.js'
import {
  discoverInternalMarket,
  discoverInternalMarketFromTokenContract,
} from './market-discovery.js'
import { reconstructTrades } from './trade-parser.js'
import { scanBlockRange, fetchSwapLogs } from './block-scanner.js'
import { checkGraduation, getReserves } from './graduation.js'
import { readTaxRecipient, extractTaxInflows } from './tax-tracker.js'
import { parseSwapEvents, getExternalSpotPrice } from './external-parser.js'
import { updateAddressCosts } from '../metrics/address-cost.js'
import { updateTokenBalances } from '../metrics/token-balance.js'
import { eventBus } from './event-bus.js'
import { updatePriceState, updateSpotPriceFromTrade, setCachedGradInfo, getCachedGradInfo } from './price-cache.js'
import { getTransferLogFailureStat } from './observability.js'
import type { Trade, WsTrade, WsWhaleAlert, WsStateUpdate } from '../types.js'

/**
 * Initialize a project: read contract state, detect graduation, set up indexer state.
 * RPC timeouts are handled by viem transport (10s per request).
 */
export async function initializeProject(projectId: string): Promise<void> {
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get()

  if (!project) {
    throw new Error(`Project ${projectId} not found`)
  }

  const tokenAddress = project.tokenAddress as Address
  const client = getClient()

  console.log(`[Indexer] Initializing project ${projectId} (${tokenAddress})`)

  // Step 1: Read contract metadata (viem transport handles timeout)
  try {
    const [taxRecipient, totalSupply, buyTaxBps] = await Promise.all([
      readTaxRecipient(tokenAddress).catch(() => null),
      client.readContract({
        address: tokenAddress, abi: TOKEN_ABI, functionName: 'totalSupply',
      }).catch(() => null),
      client.readContract({
        address: tokenAddress, abi: TOKEN_ABI, functionName: 'totalBuyTaxBasisPoints',
      }).catch(() => null),
    ])

    {
      const updates: Record<string, any> = {}
      if (taxRecipient) updates.taxRecipient = taxRecipient
      if (totalSupply) updates.totalSupply = totalSupply.toString()
      if (buyTaxBps !== null && buyTaxBps !== undefined)
        updates.buyTaxBps = Number(buyTaxBps)

      if (Object.keys(updates).length > 0) {
        db.update(schema.projects).set(updates).where(eq(schema.projects.id, projectId)).run()
        console.log(`[Indexer] Updated contract metadata:`, updates)
      }
    }
  } catch (err) {
    console.warn(`[Indexer] Failed to read contract metadata (non-fatal)`)
  }

  // Step 2: Check graduation (viem transport handles timeout)
  try {
    const gradResult = await checkGraduation(tokenAddress)

    if (gradResult && gradResult.graduated && gradResult.pairAddress) {
      const existingExternal = db.select().from(schema.markets)
        .where(and(eq(schema.markets.projectId, projectId), eq(schema.markets.venue, 'EXTERNAL')))
        .get()

      if (!existingExternal) {
        let latestBlock = 0
        try { latestBlock = Number(await client.getBlockNumber()) } catch {}

        db.insert(schema.markets).values({
          id: `${projectId}-external`, projectId, venue: 'EXTERNAL',
          marketAddress: gradResult.pairAddress, quoteToken: VIRTUAL_ADDRESS,
          token0: gradResult.token0 || null,
          token1: gradResult.token1 || null,
          startBlock: latestBlock, startTs: Math.floor(Date.now() / 1000),
        }).onConflictDoNothing().run()

        db.update(schema.projects).set({
          phase: 'EXTERNAL', graduatedAt: Math.floor(Date.now() / 1000),
        }).where(eq(schema.projects.id, projectId)).run()

        console.log(`[Indexer] Already graduated! External pair: ${gradResult.pairAddress}`)

        // Cache graduation info in memory too
        if (gradResult.token0 && gradResult.token1) {
          const isToken0 = getAddress(gradResult.token0).toLowerCase() === getAddress(tokenAddress).toLowerCase()
          setCachedGradInfo(projectId, gradResult.token0, gradResult.token1, isToken0, gradResult.pairAddress)
        }
      }
    }
  } catch (err) {
    console.warn(`[Indexer] Graduation check failed (non-fatal, will retry in loop)`)
  }

  // Re-read project state
  const currentProject = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!
  const isGraduated = currentProject.phase === 'EXTERNAL'

  // Step 3: Set first active block
  if (!currentProject.firstActiveBlock) {
    let firstBlock: number | null = null

    try {
      // Prefer actual first Transfer block for historical backfill.
      // Fallback to latest block if scan fails.
      firstBlock = await findFirstActiveBlock(tokenAddress)
    } catch {
      try {
        firstBlock = Number(await client.getBlockNumber())
      } catch {
        // Will be set later in loop
      }
    }

    if (firstBlock) {
      db.update(schema.projects)
        .set({ firstActiveBlock: firstBlock })
        .where(eq(schema.projects.id, projectId)).run()
      console.log(`[Indexer] Starting from block: ${firstBlock}`)
    }
  }

  // Step 4: Initialize indexer state if needed
  // Step 3.5: Discover internal market if project is still internal.
  // This is required for internal trades/price/tax metrics.
  if (!isGraduated) {
    const existingInternal = db
      .select()
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.projectId, projectId),
          eq(schema.markets.venue, 'INTERNAL'),
        ),
      )
      .get()

    try {
      const refreshedProject = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .get()!

      const discoveryFromBlock =
        refreshedProject.firstActiveBlock ||
        Number(await client.getBlockNumber())

      // Prefer deterministic contract hint before heuristic discovery.
      const hintedAddress = await discoverInternalMarketFromTokenContract(
        tokenAddress,
      )

      if (existingInternal) {
        if (
          hintedAddress &&
          existingInternal.marketAddress.toLowerCase() !== hintedAddress.toLowerCase()
        ) {
          db.update(schema.markets)
            .set({ marketAddress: hintedAddress })
            .where(eq(schema.markets.id, existingInternal.id))
            .run()
          console.warn(
            `[Indexer] Corrected internal market for ${projectId}: ${existingInternal.marketAddress} -> ${hintedAddress}`,
          )
        }
      } else {
        const internal = hintedAddress
          ? { marketAddress: hintedAddress }
          : await discoverInternalMarket(tokenAddress, discoveryFromBlock)
        const discoveredAddress = internal?.marketAddress ?? null

        if (discoveredAddress) {
          db.insert(schema.markets)
            .values({
              id: `${projectId}-internal`,
              projectId,
              venue: 'INTERNAL',
              marketAddress: discoveredAddress,
              quoteToken: VIRTUAL_ADDRESS,
              startBlock: refreshedProject.firstActiveBlock || discoveryFromBlock,
              startTs: Math.floor(Date.now() / 1000),
            })
            .onConflictDoNothing()
            .run()
          console.log(`[Indexer] Internal market discovered: ${discoveredAddress}`)
        } else {
          console.warn(
            `[Indexer] Internal market discovery failed (will retry in loop)`,
          )
        }
      }
    } catch (err) {
      console.warn(
        `[Indexer] Internal market discovery error (non-fatal):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Step 4: Initialize indexer state if needed
  const state = db.select().from(schema.indexerState)
    .where(eq(schema.indexerState.projectId, projectId)).get()

  if (!state) {
    const updated = db.select().from(schema.projects)
      .where(eq(schema.projects.id, projectId)).get()!

    db.insert(schema.indexerState).values({
      projectId, lastProcessedBlock: updated.firstActiveBlock || 0,
    }).onConflictDoNothing().run()
  }

  console.log(`[Indexer] Project ${projectId} initialization complete (graduated: ${isGraduated})`)
}

/**
 * Process a range of blocks for a project (backfill or realtime).
 */
async function processBlockRange(
  projectId: string,
  fromBlock: number,
  toBlock: number,
): Promise<number> {
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get()!

  const tokenAddress = project.tokenAddress as Address
  const isGraduated = project.phase === 'EXTERNAL'

  // Get markets
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

  const externalMarket = db
    .select()
    .from(schema.markets)
    .where(
      and(
        eq(schema.markets.projectId, projectId),
        eq(schema.markets.venue, 'EXTERNAL'),
      ),
    )
    .get()

  // Scan blocks for Transfer logs.
  // Even after graduation, keep VIRTUAL transfers if tax recipient exists
  // so tax inflows remain complete across phase changes.
  const skipVirtualTransfers = isGraduated && !project.taxRecipient
  const blockData = await scanBlockRange(
    tokenAddress,
    fromBlock,
    toBlock,
    skipVirtualTransfers,
  )

  let totalTrades = 0

  for (const block of blockData) {
    const allTrades: Trade[] = []

    // Update token balances from ALL Transfer events (not just trades)
    updateTokenBalances(projectId, block.tokenTransfers)

    // Parse internal market trades
    if (
      internalMarket &&
      (!internalMarket.endBlock || block.blockNumber <= internalMarket.endBlock)
    ) {
      const internalTrades = reconstructTrades(
        block.tokenTransfers,
        block.virtualTransfers,
        internalMarket.marketAddress as Address,
        tokenAddress,
        projectId,
        'INTERNAL',
        block.timestamp,
      )
      allTrades.push(...internalTrades)
    }

    // Parse external market trades (from Swap events, handled separately)
    // External trades are parsed via fetchSwapLogs in the main loop

    // Extract tax inflows
    if (project.taxRecipient) {
      const taxInflows = extractTaxInflows(
        block.tokenTransfers,
        block.virtualTransfers,
        project.taxRecipient as Address,
        projectId,
        block.timestamp,
      )

      for (const inflow of taxInflows) {
        try {
          db.insert(schema.taxInflows)
            .values(inflow)
            .onConflictDoNothing()
            .run()
        } catch {
          // Duplicate, skip
        }
      }
    }

    // Insert trades and update costs (only for newly inserted rows)
    const insertedInternalTrades: Trade[] = []
    for (const trade of allTrades) {
      try {
        const result = db
          .insert(schema.trades)
          .values(trade)
          .onConflictDoNothing()
          .run()
        if ((result as any)?.changes > 0) {
          insertedInternalTrades.push(trade)
        }

        // Emit events
        eventBus.emit({
          type: 'trade',
          projectId,
          trade,
        } as WsTrade)

        // Check whale threshold using GROSS amount (user's actual outlay)
        const quoteAmount = trade.quoteInGross
          ? BigInt(trade.quoteInGross)
          : trade.quoteIn
            ? BigInt(trade.quoteIn)
            : 0n
        if (quoteAmount >= config.whaleThresholdSingleTrade) {
          eventBus.emit({
            type: 'whale_alert',
            projectId,
            address: trade.trader,
            quoteIn: trade.quoteInGross || trade.quoteIn || '0',
            side: trade.side,
          } as WsWhaleAlert)
        }
      } catch {
        // Duplicate trade, skip
      }
    }

    // Update address costs for newly inserted trades only
    if (insertedInternalTrades.length > 0) {
      updateAddressCosts(insertedInternalTrades)
    }
    totalTrades += insertedInternalTrades.length
  }

  // Process external swap events separately
  if (externalMarket) {
    const swapLogs = await fetchSwapLogs(
      externalMarket.marketAddress as Address,
      fromBlock,
      toBlock,
    )

    if (swapLogs.length > 0) {
      // Get token0/token1 from cache (no RPC!)
      const cached = getCachedGradInfo(projectId)
      let token0: Address = (cached?.token0 as Address) || '0x0000000000000000000000000000000000000000'
      let token1: Address = (cached?.token1 as Address) || '0x0000000000000000000000000000000000000000'

      if (!cached) {
        // Fallback: fetch from chain (only if cache miss)
        try {
          const gradInfo = await checkGraduation(tokenAddress)
          if (gradInfo.token0) token0 = gradInfo.token0
          if (gradInfo.token1) token1 = gradInfo.token1
        } catch {}
      }

      // Get timestamp for swap logs
      const blockTimestamps = new Map<number, number>()
      for (const bd of blockData) {
        blockTimestamps.set(bd.blockNumber, bd.timestamp)
      }

      // Group swap logs by block for timestamps
      const rpcClient = getClient()
      for (const log of swapLogs) {
        const bn = Number(log.blockNumber)
        if (!blockTimestamps.has(bn)) {
          try {
            const block = await rpcClient.getBlock({ blockNumber: BigInt(bn) })
            blockTimestamps.set(bn, Number(block.timestamp))
          } catch {
            blockTimestamps.set(bn, Math.floor(Date.now() / 1000))
          }
        }
      }

      const externalTrades = parseSwapEvents(
        swapLogs,
        externalMarket.marketAddress as Address,
        token0,
        token1,
        tokenAddress,
        projectId,
        0, // Timestamp set per-trade below
      )

      // Fix timestamps
      for (const trade of externalTrades) {
        trade.ts =
          blockTimestamps.get(trade.blockNumber) ||
          Math.floor(Date.now() / 1000)
      }

      const insertedExternalTrades: Trade[] = []
      for (const trade of externalTrades) {
        try {
          const result = db
            .insert(schema.trades)
            .values(trade)
            .onConflictDoNothing()
            .run()
          if ((result as any)?.changes > 0) {
            insertedExternalTrades.push(trade)
          }

          eventBus.emit({ type: 'trade', projectId, trade } as WsTrade)

          const quoteAmount = trade.quoteInGross
            ? BigInt(trade.quoteInGross)
            : trade.quoteIn
              ? BigInt(trade.quoteIn)
              : 0n
          if (quoteAmount >= config.whaleThresholdSingleTrade) {
            eventBus.emit({
              type: 'whale_alert',
              projectId,
              address: trade.trader,
              quoteIn: trade.quoteInGross || trade.quoteIn || '0',
              side: trade.side,
            } as WsWhaleAlert)
          }
        } catch {}
      }

      if (insertedExternalTrades.length > 0) {
        updateAddressCosts(insertedExternalTrades)
      }
      totalTrades += insertedExternalTrades.length
    }
  }

  const tokenLogFailure = getTransferLogFailureStat(tokenAddress)
  const virtualLogFailure = getTransferLogFailureStat(VIRTUAL_ADDRESS as Address)
  const mergedFailure = [tokenLogFailure, virtualLogFailure]
    .filter((x) => !!x)
    .sort((a, b) => (b!.lastFailureAt || 0) - (a!.lastFailureAt || 0))[0]
  const mergedFailureCount =
    (tokenLogFailure?.failureCount || 0) + (virtualLogFailure?.failureCount || 0)

  // Update indexer state
  db.update(schema.indexerState)
    .set({
      lastProcessedBlock: toBlock,
      lastProcessedTs: Math.floor(Date.now() / 1000),
      transferLogFailureCount: mergedFailureCount || null,
      lastTransferLogFailureAt: mergedFailure?.lastFailureAt || null,
      lastTransferLogFailureContract: mergedFailure?.contractAddress || null,
      lastTransferLogFailureFromBlock: mergedFailure?.lastFailureRange.fromBlock || null,
      lastTransferLogFailureToBlock: mergedFailure?.lastFailureRange.toBlock || null,
      lastTransferLogFailureError: mergedFailure?.lastError || null,
    })
    .where(eq(schema.indexerState.projectId, projectId))
    .run()

  db.update(schema.projects)
    .set({ lastIndexedBlock: toBlock })
    .where(eq(schema.projects.id, projectId))
    .run()

  return totalTrades
}

/**
 * Backfill INTERNAL trades for a historical range.
 * This is used when internal market is discovered late, so earlier blocks
 * can still contribute to recent trades/cost metrics.
 *
 * Important: this does NOT touch token_balances or tax_inflows; it only
 * inserts deduped trades and updates costs for newly inserted trades.
 */
async function backfillInternalTradesRange(
  projectId: string,
  tokenAddress: Address,
  marketAddress: Address,
  fromBlock: number,
  toBlock: number,
): Promise<number> {
  if (fromBlock > toBlock) return 0

  let insertedTotal = 0
  const batchSize = 100
  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock)
    const blockData = await scanBlockRange(tokenAddress, start, end, false)

    const insertedBatch: Trade[] = []
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
          const result = db
            .insert(schema.trades)
            .values(trade)
            .onConflictDoNothing()
            .run()
          if ((result as any)?.changes > 0) {
            insertedBatch.push(trade)
          }
        } catch {
          // Ignore duplicates/non-fatal insert errors
        }
      }
    }

    if (insertedBatch.length > 0) {
      updateAddressCosts(insertedBatch)
      insertedTotal += insertedBatch.length
    }
  }

  return insertedTotal
}

/**
 * Main indexer loop for a single project.
 * Backfills from last processed block, then enters real-time polling.
 */
export async function runIndexerLoop(
  projectId: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = getClient()

  console.log(`[Indexer] Starting loop for project ${projectId}`)

  let lastGraduationCheck = 0
  let lastInternalMarketCheck = 0

  // Restore graduation info + price from DB (zero RPC), then try to refresh from chain
  {
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!
    const externalMarket = db.select().from(schema.markets).where(
      and(eq(schema.markets.projectId, projectId), eq(schema.markets.venue, 'EXTERNAL'))
    ).get()

    if (externalMarket) {
      // Step A: Restore grad info from DB (zero RPC)
      if (externalMarket.token0 && externalMarket.token1) {
        const isToken0 = getAddress(externalMarket.token0).toLowerCase() === getAddress(project.tokenAddress).toLowerCase()
        setCachedGradInfo(projectId, externalMarket.token0, externalMarket.token1, isToken0, externalMarket.marketAddress)
        console.log(`[Indexer] Restored grad info from DB: isToken0=${isToken0}`)
      }

      // Step B: Restore last known price from DB (zero RPC)
      if (project.lastSpotPrice) {
        const cached = getCachedGradInfo(projectId)
        updatePriceState(projectId, project.lastSpotPrice, 0n, 0n, cached?.isToken0 ?? false)
        console.log(`[Indexer] Restored last price from DB: ${project.lastSpotPrice.toExponential(4)}`)
      }

      // Step C: Try to fetch fresh grad info from chain (awaited, viem handles timeout)
      if (!externalMarket.token0 || !externalMarket.token1) {
        try {
          const gradInfo = await checkGraduation(project.tokenAddress as Address)
          if (gradInfo && gradInfo.token0 && gradInfo.token1) {
            const isToken0 = getAddress(gradInfo.token0).toLowerCase() === getAddress(project.tokenAddress).toLowerCase()
            setCachedGradInfo(projectId, gradInfo.token0, gradInfo.token1, isToken0, externalMarket.marketAddress)
            db.update(schema.markets).set({ token0: gradInfo.token0, token1: gradInfo.token1 })
              .where(eq(schema.markets.id, externalMarket.id)).run()
            console.log(`[Indexer] Persisted grad info: isToken0=${isToken0}`)
          }
        } catch (e) {
          console.warn(`[Indexer] Failed to fetch grad info (will retry): ${e instanceof Error ? e.message : e}`)
        }
      }

      // Try to refresh reserves (awaited, viem handles timeout)
      const cached = getCachedGradInfo(projectId)
      if (cached) {
        try {
          const reserves = await getReserves(cached.pairAddress as Address)
          if (reserves && reserves.reserve0 > 0n && reserves.reserve1 > 0n) {
            const spotPrice = cached.isToken0
              ? Number(reserves.reserve1) / Number(reserves.reserve0)
              : Number(reserves.reserve0) / Number(reserves.reserve1)
            const reserveVirtual = cached.isToken0 ? reserves.reserve1 : reserves.reserve0
            const reserveToken = cached.isToken0 ? reserves.reserve0 : reserves.reserve1
            updatePriceState(projectId, spotPrice, reserveVirtual, reserveToken, cached.isToken0)
            db.update(schema.projects).set({ lastSpotPrice: spotPrice }).where(eq(schema.projects.id, projectId)).run()
            console.log(`[Indexer] Refreshed spot price: ${spotPrice.toExponential(4)}`)
          }
        } catch {
          // Non-fatal
        }
      }
    }
  }

  while (!signal?.aborted) {
    try {
      const state = db
        .select()
        .from(schema.indexerState)
        .where(eq(schema.indexerState.projectId, projectId))
        .get()

      if (!state) {
        console.error(`[Indexer] No state for project ${projectId}`)
        break
      }

      // viem transport has built-in 10s timeout that properly aborts connections
      const latestBlock = Number(await client.getBlockNumber())
      const safeBlock = latestBlock - config.confirmations
      const fromBlock = state.lastProcessedBlock + 1

      // Ensure internal market exists for INTERNAL projects.
      // If missing, we cannot reconstruct internal trades/price/tax.
      const nowMs = Date.now()
      if (nowMs - lastInternalMarketCheck > 60_000) {
        lastInternalMarketCheck = nowMs
        const projectNow = db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .get()

        if (projectNow && projectNow.phase === 'INTERNAL') {
          const existingInternal = db
            .select()
            .from(schema.markets)
            .where(
              and(
                eq(schema.markets.projectId, projectId),
                eq(schema.markets.venue, 'INTERNAL'),
              ),
            )
            .get()

          try {
            const discoveryFrom =
              projectNow.firstActiveBlock || Math.max(fromBlock, safeBlock - 20_000)
            const hintedAddress = await discoverInternalMarketFromTokenContract(
              projectNow.tokenAddress as Address,
            )

            if (existingInternal) {
              if (
                hintedAddress &&
                existingInternal.marketAddress.toLowerCase() !== hintedAddress.toLowerCase()
              ) {
                db.update(schema.markets)
                  .set({ marketAddress: hintedAddress })
                  .where(eq(schema.markets.id, existingInternal.id))
                  .run()
                console.warn(
                  `[Indexer] Corrected internal market in loop for ${projectId}: ${existingInternal.marketAddress} -> ${hintedAddress}`,
                )
              }
            } else {
              const discovered = hintedAddress
                ? { marketAddress: hintedAddress }
                : await discoverInternalMarket(
                  projectNow.tokenAddress as Address,
                  discoveryFrom,
                )

              if (discovered?.marketAddress) {
                const discoveredAddress = discovered.marketAddress as Address
                db.insert(schema.markets)
                  .values({
                    id: `${projectId}-internal`,
                    projectId,
                    venue: 'INTERNAL',
                    marketAddress: discoveredAddress,
                    quoteToken: VIRTUAL_ADDRESS,
                    startBlock: projectNow.firstActiveBlock || discoveryFrom,
                    startTs: Math.floor(Date.now() / 1000),
                  })
                  .onConflictDoNothing()
                  .run()
                console.log(
                  `[Indexer] Internal market discovered in loop: ${discoveredAddress}`,
                )

                // Backfill historical INTERNAL trades that were missed before market discovery.
                const backfillFrom = projectNow.firstActiveBlock || discoveryFrom
                const backfillTo = Math.max(backfillFrom, fromBlock - 1)
                if (backfillTo >= backfillFrom) {
                  try {
                    const inserted = await backfillInternalTradesRange(
                      projectId,
                      projectNow.tokenAddress as Address,
                      discoveredAddress,
                      backfillFrom,
                      backfillTo,
                    )
                    if (inserted > 0) {
                      console.log(
                        `[Indexer] Backfilled ${inserted} INTERNAL trades for ${projectId} in [${backfillFrom}, ${backfillTo}]`,
                      )
                    }
                  } catch (err) {
                    console.warn(
                      `[Indexer] Internal trade backfill failed (non-fatal):`,
                      err instanceof Error ? err.message : err,
                    )
                  }
                }
              }
            }
          } catch (err) {
            console.warn(
              `[Indexer] Internal market retry failed (non-fatal):`,
              err instanceof Error ? err.message : err,
            )
          }
        }
      }

      if (fromBlock > safeBlock) {
        // Up to date, wait for new blocks
        await sleep(config.pollIntervalMs)
        continue
      }

      // Process in batches of up to 100 blocks
      const batchSize = 100
      const toBlock = Math.min(fromBlock + batchSize - 1, safeBlock)

      const tradeCount = await processBlockRange(projectId, fromBlock, toBlock)

      if (tradeCount > 0) {
        console.log(
          `[Indexer] Project ${projectId}: blocks ${fromBlock}-${toBlock}, ${tradeCount} trades`,
        )
      }

      // Check graduation periodically
      const now = Date.now()
      if (now - lastGraduationCheck > config.graduationPollMs) {
        lastGraduationCheck = now

        const project = db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .get()!

        if (project.phase === 'INTERNAL') {
          const gradResult = await checkGraduation(
            project.tokenAddress as Address,
          )

          if (gradResult.graduated && gradResult.pairAddress) {
            console.log(
              `[Indexer] Project ${projectId} GRADUATED! Pair: ${gradResult.pairAddress}`,
            )

            // Close internal market
            db.update(schema.markets)
              .set({ endBlock: toBlock, endTs: Math.floor(Date.now() / 1000) })
              .where(
                and(
                  eq(schema.markets.projectId, projectId),
                  eq(schema.markets.venue, 'INTERNAL'),
                ),
              )
              .run()

            // Create external market
            db.insert(schema.markets)
              .values({
                id: `${projectId}-external`,
                projectId,
                venue: 'EXTERNAL',
                marketAddress: gradResult.pairAddress,
                quoteToken: VIRTUAL_ADDRESS,
                startBlock: toBlock,
                startTs: Math.floor(Date.now() / 1000),
              })
              .onConflictDoNothing()
              .run()

            // Update project phase
            db.update(schema.projects)
              .set({
                phase: 'EXTERNAL',
                graduatedAt: Math.floor(Date.now() / 1000),
              })
              .where(eq(schema.projects.id, projectId))
              .run()

            // Emit state update
            eventBus.emit({
              type: 'state',
              projectId,
              spotPrice: null,
              fdv: null,
              phase: 'EXTERNAL',
            } as WsStateUpdate)
          }
        }
      }

      // Update cached price from reserves (1 RPC call, viem handles timeout)
      try {
        const cached = getCachedGradInfo(projectId)
        if (cached) {
          const reserves = await getReserves(cached.pairAddress as Address)
          if (reserves && reserves.reserve0 > 0n && reserves.reserve1 > 0n) {
            const spotPrice = cached.isToken0
              ? Number(reserves.reserve1) / Number(reserves.reserve0)
              : Number(reserves.reserve0) / Number(reserves.reserve1)
            const reserveVirtual = cached.isToken0 ? reserves.reserve1 : reserves.reserve0
            const reserveToken = cached.isToken0 ? reserves.reserve0 : reserves.reserve1
            updatePriceState(projectId, spotPrice, reserveVirtual, reserveToken, cached.isToken0)
            db.update(schema.projects).set({ lastSpotPrice: spotPrice }).where(eq(schema.projects.id, projectId)).run()
          }
        }
      } catch {
        // Non-fatal: price cache update failed
      }

      // If we're caught up (batch < batchSize), slow down
      if (toBlock - fromBlock < batchSize - 1) {
        await sleep(config.pollIntervalMs)
      }
    } catch (error: any) {
      const msg = error?.message || error?.details || ''
      const is429 = msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate')
      const backoff = is429 ? 30_000 : 10_000
      console.error(
        `[Indexer] Error in loop for ${projectId}${is429 ? ' (rate limited, backing off ' + backoff/1000 + 's)' : ''}:`,
        error instanceof Error ? error.message : error,
      )
      await sleep(backoff)
    }
  }

  console.log(`[Indexer] Loop stopped for project ${projectId}`)
}

