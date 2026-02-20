import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { config } from '../config.js'
import { projectRoutes } from './routes/projects.js'
import { tradeRoutes } from './routes/trades.js'
import { simulateRoutes } from './routes/simulate.js'
import { registerWebSocket } from './ws.js'

export async function startApiServer(): Promise<void> {
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  })

  // Register plugins
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  })

  await fastify.register(websocket)

  // Register routes
  await fastify.register(projectRoutes)
  await fastify.register(tradeRoutes)
  await fastify.register(simulateRoutes)
  await fastify.register(registerWebSocket)

  // Root route
  fastify.get('/', async () => ({
    name: 'Virtual Launch Analytics API',
    version: '1.0.0',
    endpoints: {
      'GET /health': 'Health check',
      'GET /projects': 'List all tracked projects',
      'POST /projects': 'Add a new project { tokenAddress, name? }',
      'GET /projects/:id/state': 'Full project state (price, FDV, EFDV, tax, graduation)',
      'GET /projects/:id/efdv/layers?mode=prelaunch|live': 'Layered EFDV dashboard (tax layers + breakeven)',
      'GET /projects/:id/probability/marketcap-threshold?target=&horizon=': 'Probability of reaching market cap target during buyback window',
      'GET /projects/:id/whales?limit=20&excludeSystem=true': 'Top holders by token balance',
      'GET /projects/:id/whales/internal?limit=20&excludeSystem=true': 'Internal-market whale profile',
      'GET /projects/:id/whales/activity?limit=50&offset=0&threshold=': 'Large whale activity stream',
      'GET /projects/:id/whales/activity/:address?limit=50&offset=0&threshold=': 'Address-scoped whale activity stream',
      'GET /projects/:id/whales/pressure': 'Concentration + pressure tiers',
      'GET /projects/:id/whales/absorption?sellShare=0.25&topN=20&mode=IDEAL': 'Tax absorption vs dump demand',
      'GET /projects/:id/addresses/:address?limit=30': 'Address detail (cost + recent trades)',
      'GET /projects/:id/diagnostics/reconcile?limit=20': 'Reconciliation snapshot (holders + tax + indexer)',
      'GET /projects/:id/costs/summary': 'Cost distribution (weighted avg, percentiles)',
      'GET /projects/:id/tax/summary': 'Tax accumulation (actual + estimated)',
      'GET /projects/:id/trades?limit=200&venue=&side=': 'Paginated trade list',
      'POST /projects/:id/simulate-buyback': 'Buyback impact simulation { amountPerStep, intervalSeconds, totalTaxInput, realisticMode? }',
      'POST /projects/:id/simulate-dump': 'Dump impact simulation { sellAmount? | sellShare?, topN?, mode? }',
      'WS /ws?projectId=': 'Real-time events (trade, whale_alert, state)',
    },
  }))

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }))

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`[API] Server listening on http://0.0.0.0:${config.port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

