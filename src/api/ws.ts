import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { eventBus } from '../indexer/event-bus.js'
import type { WsEvent } from '../types.js'

/**
 * Register WebSocket route for real-time event streaming.
 * Clients connect to /ws?projectId=xxx to receive events for a specific project.
 */
export async function registerWebSocket(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`)
    const projectId = url.searchParams.get('projectId')

    console.log(
      `[WS] Client connected${projectId ? ` for project ${projectId}` : ''}`,
    )

    const unsubscribe = eventBus.subscribe((event: WsEvent) => {
      // Filter by project if specified
      if (projectId && event.projectId !== projectId) return

      try {
        socket.send(JSON.stringify(event))
      } catch (err) {
        console.error('[WS] Failed to send:', err)
      }
    })

    socket.on('close', () => {
      console.log('[WS] Client disconnected')
      unsubscribe()
    })

    socket.on('error', (err: Error) => {
      console.error('[WS] Socket error:', err)
      unsubscribe()
    })

    // Send initial ping
    socket.send(JSON.stringify({ type: 'connected', projectId }))
  })
}

