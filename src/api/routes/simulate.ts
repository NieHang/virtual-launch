import type { FastifyInstance } from 'fastify'
import { type Address, getAddress } from 'viem'
import { db, schema } from '../../db/index.js'
import { eq, and, desc } from 'drizzle-orm'
import { simulateBuyback } from '../../metrics/buyback-sim.js'
import { getPriceState } from '../../indexer/price-cache.js'
import { getReserves, checkGraduation } from '../../indexer/graduation.js'
import { getClient } from '../../chain/client.js'
import { TOKEN_ABI, VIRTUAL_ADDRESS } from '../../chain/constants.js'

export async function simulateRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /projects/:id/simulate-buyback
   *
   * Body params:
   *   amountPerStep   - Buyback amount per interval (in wei). Required.
   *   intervalSeconds - Seconds between buybacks. Required.
   *   totalTaxInput   - Total tax budget used for simulation (in wei). Required.
   */
  fastify.post<{
    Params: { id: string }
    Body: {
      amountPerStep: string
      intervalSeconds: number
      totalTaxInput: string
      realisticMode?: boolean
      anchorToSpotPrice?: boolean
    }
  }>('/projects/:id/simulate-buyback', async (request, reply) => {
    const { id } = request.params
    const body = request.body || {}

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    const externalMarket = db
      .select()
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.projectId, id),
          eq(schema.markets.venue, 'EXTERNAL'),
        ),
      )
      .get()

    const internalMarket = db
      .select()
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.projectId, id),
          eq(schema.markets.venue, 'INTERNAL'),
        ),
      )
      .get()

    let amountPerStep: bigint
    let totalTaxInput: bigint
    let intervalSeconds: number
    try {
      amountPerStep = BigInt(body.amountPerStep)
      totalTaxInput = BigInt(body.totalTaxInput)
      intervalSeconds = Number(body.intervalSeconds)
    } catch {
      return reply.code(400).send({
        error: 'Invalid input. amountPerStep and totalTaxInput must be bigint strings.',
      })
    }

    if (amountPerStep <= 0n || totalTaxInput <= 0n || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      return reply.code(400).send({
        error: 'Invalid input. amountPerStep, totalTaxInput, intervalSeconds must be > 0.',
      })
    }

    // Prefer external pair reserves if available; fallback to internal market balances.
    const priceCache = getPriceState(id)

    let reserve0: bigint
    let reserve1: bigint
    let isToken0: boolean

    if (
      externalMarket &&
      priceCache &&
      priceCache.reserveVirtual > 0n &&
      priceCache.reserveToken > 0n
    ) {
      // Use cached reserves
      isToken0 = priceCache.isToken0
      reserve0 = isToken0 ? priceCache.reserveToken : priceCache.reserveVirtual
      reserve1 = isToken0 ? priceCache.reserveVirtual : priceCache.reserveToken
    } else if (externalMarket) {
      // External market: fallback to pair reserves via RPC
      const reserves = await getReserves(externalMarket.marketAddress as Address)
      if (!reserves) {
        return reply.code(500).send({
          error: 'Failed to read reserves from pair contract.',
        })
      }

      const gradInfo = await checkGraduation(project.tokenAddress as Address)
      isToken0 = gradInfo.token0
        ? getAddress(gradInfo.token0).toLowerCase() ===
          getAddress(project.tokenAddress).toLowerCase()
        : false

      reserve0 = reserves.reserve0
      reserve1 = reserves.reserve1
    } else if (internalMarket) {
      // Internal market: approximate reserves from market wallet balances.
      // This enables buyback simulation before graduation.
      const client = getClient()
      const marketAddress = internalMarket.marketAddress as Address
      const tokenAddress = project.tokenAddress as Address
      const virtualAddress = VIRTUAL_ADDRESS as Address

      const [tokenBalance, virtualBalance] = await Promise.all([
        client.readContract({
          address: tokenAddress,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [marketAddress],
        }) as Promise<bigint>,
        client.readContract({
          address: virtualAddress,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [marketAddress],
        }) as Promise<bigint>,
      ])

      if (tokenBalance <= 0n || virtualBalance <= 0n) {
        return reply.code(400).send({
          error:
            'Internal market has zero liquidity balance. Cannot simulate buyback yet.',
        })
      }

      // Feed simulator in "token0=project, token1=virtual" layout.
      isToken0 = true
      reserve0 = tokenBalance
      reserve1 = virtualBalance
    } else {
      return reply.code(400).send({
        error:
          'No active market found for this project (neither INTERNAL nor EXTERNAL).',
      })
    }

    const result = simulateBuyback(
      reserve0,
      reserve1,
      isToken0,
      amountPerStep,
      totalTaxInput,
      intervalSeconds,
      body.realisticMode ? 'REALISTIC' : 'IDEAL',
      (() => {
        const anchorEnabled = body.anchorToSpotPrice !== false
        if (!anchorEnabled) return null

        const cachedSpot = getPriceState(id)?.spotPrice
        if (cachedSpot && Number.isFinite(cachedSpot) && cachedSpot > 0) return cachedSpot
        if (
          project.lastSpotPrice &&
          Number.isFinite(project.lastSpotPrice) &&
          project.lastSpotPrice > 0
        ) {
          return project.lastSpotPrice
        }

        const lastTrade = db
          .select()
          .from(schema.trades)
          .where(eq(schema.trades.projectId, id))
          .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
          .limit(1)
          .get()
        if (
          lastTrade?.priceQuotePerToken &&
          Number.isFinite(lastTrade.priceQuotePerToken) &&
          lastTrade.priceQuotePerToken > 0
        ) {
          return lastTrade.priceQuotePerToken
        }
        return null
      })(),
    )

    return result
  })
}
