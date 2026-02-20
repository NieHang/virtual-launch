/**
 * HTTP proxy support for RPC and external API calls.
 * Does NOT set global dispatcher (avoids interfering with WS/localhost connections).
 * Instead provides explicit proxy functions for targeted use.
 */

import { ProxyAgent, request as undiciRequest } from 'undici'
import { config as dotenvConfig } from 'dotenv'

dotenvConfig()

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY

let proxyAgent: ProxyAgent | null = null

if (proxyUrl) {
  proxyAgent = new ProxyAgent({
    uri: proxyUrl,
    connections: 30,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  })
  console.log(`[Proxy] Proxy configured: ${proxyUrl}`)
} else {
  console.log(`[Proxy] No proxy configured`)
}

/**
 * Get the ProxyAgent instance (or null if no proxy).
 */
export function getProxyAgent(): ProxyAgent | null {
  return proxyAgent
}

/**
 * Make an RPC JSON-RPC call through proxy with explicit timeout.
 */
export async function proxyRpcCall(
  rpcUrl: string,
  method: string,
  params: any[],
  timeoutMs = 10_000,
): Promise<any> {
  const id = Date.now()
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

  const opts: any = {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: payload,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  }

  if (proxyAgent) {
    opts.dispatcher = proxyAgent
  }

  const { body } = await undiciRequest(rpcUrl, opts)
  const data = await body.json() as any

  if (data.error) {
    throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`)
  }

  return data.result
}

/**
 * Proxy-aware fetch for external APIs (Gate.io, DexScreener, etc).
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  if (proxyAgent) {
    // Use undici request with dispatcher for proxy
    const opts: any = {
      method: (init?.method || 'GET') as string,
      headers: init?.headers as Record<string, string> || { 'Accept': 'application/json' },
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
      dispatcher: proxyAgent,
    }
    if (init?.body) opts.body = init.body
    if (init?.signal) opts.signal = init.signal

    const { statusCode, headers, body } = await undiciRequest(url.toString(), opts)
    const text = await body.text()

    return new Response(text, {
      status: statusCode,
      headers: headers as any,
    })
  }

  // No proxy - use native fetch
  return fetch(url, init)
}
