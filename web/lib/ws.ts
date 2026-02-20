'use client'

import { useEffect, useRef, useCallback, useState } from 'react'

export interface WsEvent {
  type: 'trade' | 'whale_alert' | 'state' | 'connected'
  projectId?: string
  [key: string]: any
}

export function useWebSocket(projectId: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null)
  const [connected, setConnected] = useState(false)
  const reconnectTimerRef = useRef<NodeJS.Timeout>()

  const connect = useCallback(() => {
    if (!projectId) return

    const wsUrl = `ws://${window.location.hostname}:3001/ws?projectId=${projectId}`

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[WS] Connected')
        setConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsEvent
          setLastEvent(data)
        } catch {}
      }

      ws.onclose = () => {
        console.log('[WS] Disconnected, reconnecting...')
        setConnected(false)
        reconnectTimerRef.current = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        ws.close()
      }
    } catch {}
  }, [projectId])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { lastEvent, connected }
}

