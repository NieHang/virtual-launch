import type { FastifyInstance } from 'fastify'
import { db, schema } from '../../db/index.js'
import { eq, and, desc } from 'drizzle-orm'

export async function tradeRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /projects/:id/trades
  fastify.get<{
    Params: { id: string }
    Querystring: {
      limit?: string
      offset?: string
      venue?: string
      side?: string
    }
  }>('/projects/:id/trades', async (request, reply) => {
    const { id } = request.params
    const limit = Math.min(parseInt(request.query.limit || '200', 10), 1000)
    const offset = parseInt(request.query.offset || '0', 10)
    const venue = request.query.venue
    const side = request.query.side

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id))
      .get()

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    // Build query with conditions
    let conditions = [eq(schema.trades.projectId, id)]

    if (venue === 'INTERNAL' || venue === 'EXTERNAL') {
      conditions.push(eq(schema.trades.venue, venue))
    }
    if (side === 'BUY' || side === 'SELL') {
      conditions.push(eq(schema.trades.side, side))
    }

    const trades = db
      .select()
      .from(schema.trades)
      .where(and(...conditions))
      .orderBy(desc(schema.trades.blockNumber), desc(schema.trades.logIndex))
      .limit(limit)
      .offset(offset)
      .all()

    // Get total count for pagination
    const allMatching = db
      .select()
      .from(schema.trades)
      .where(and(...conditions))
      .all()

    return {
      trades,
      total: allMatching.length,
      limit,
      offset,
    }
  })
}

