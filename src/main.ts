import './chain/proxy.js'
import { pushSchema } from './db/migrate.js'
import { db, schema } from './db/index.js'
import { startApiServer } from './api/index.js'
import { initializeProject, runIndexerLoop } from './indexer/index.js'
import { startVirtualPriceLoop } from './chain/virtual-price.js'

async function main(): Promise<void> {
  console.log('=== Virtual Launch Analytics ===')
  console.log('')

  // Step 1: Push database schema
  pushSchema()

  // Step 2: Start VIRTUAL/USD price loop (CoinGecko, refreshes every 60s)
  startVirtualPriceLoop()

  // Step 3: Start API server
  await startApiServer()

  // Step 4: Start indexer loops for all registered projects
  const projects = db.select().from(schema.projects).all()

  if (projects.length === 0) {
    console.log(
      '[Main] No projects registered. Use `npm run add-project` to add one.',
    )
    console.log('[Main] API server is running. Waiting for projects...')

    // Poll for new projects
    const checkInterval = setInterval(async () => {
      const newProjects = db.select().from(schema.projects).all()
      if (newProjects.length > 0) {
        clearInterval(checkInterval)
        await startIndexers(newProjects.map((p) => p.id))
      }
    }, 5000)

    return
  }

  await startIndexers(projects.map((p) => p.id))
}

async function startIndexers(projectIds: string[]): Promise<void> {
  const controller = new AbortController()

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Main] Shutting down...')
    controller.abort()
    setTimeout(() => process.exit(0), 2000)
  })

  process.on('SIGTERM', () => {
    console.log('\n[Main] Shutting down...')
    controller.abort()
    setTimeout(() => process.exit(0), 2000)
  })

  // Initialize and start indexers (init has timeouts, will never hang)
  for (const projectId of projectIds) {
    try {
      await initializeProject(projectId)
    } catch (err) {
      console.warn(`[Main] Init partially failed for ${projectId} (non-fatal, indexer will continue):`,
        err instanceof Error ? err.message : err)
    }

    // Always start the indexer loop regardless of init result
    runIndexerLoop(projectId, controller.signal).catch((err) =>
      console.error(`[Main] Indexer error for ${projectId}:`, err),
    )
    console.log(`[Main] Indexer started for project ${projectId}`)
  }

  console.log(
    `[Main] ${projectIds.length} indexer(s) running. Press Ctrl+C to stop.`,
  )
}

main().catch((err) => {
  console.error('[Main] Fatal error:', err)
  process.exit(1)
})

