import type { WsEvent } from '../types.js'

type Listener = (event: WsEvent) => void

/**
 * Simple in-process event bus for broadcasting events to WebSocket clients.
 */
class EventBus {
  private listeners: Set<Listener> = new Set()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: WsEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[EventBus] Listener error:', err)
      }
    }
  }
}

export const eventBus = new EventBus()

