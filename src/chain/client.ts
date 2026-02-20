import { createPublicClient, custom, fallback, type PublicClient, type Chain, type Transport } from 'viem'
import { base } from 'viem/chains'
import { config } from '../config.js'
import { proxyRpcCall, getProxyAgent } from './proxy.js'

let clientInstance: PublicClient | null = null

/**
 * Free Base RPC endpoints as fallback.
 */
const FREE_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base',
]

/**
 * Create a custom viem transport that uses our proxy-aware RPC caller.
 * This avoids setGlobalDispatcher which interferes with WebSocket connections.
 */
function createProxiedTransport(rpcUrl: string, timeoutMs = 10_000): Transport {
  return custom({
    async request({ method, params }) {
      return proxyRpcCall(rpcUrl, method, params as any[], timeoutMs)
    },
  })
}

export function getClient(): PublicClient {
  if (!clientInstance) {
    const hasProxy = !!getProxyAgent()

    const transports = [config.rpcUrl, ...FREE_RPCS].map(url =>
      createProxiedTransport(url, 10_000)
    )

    clientInstance = createPublicClient({
      chain: base as Chain,
      transport: fallback(transports, {
        retryCount: 0,
        rank: false,  // Disable ranking to avoid background health-check connections
      }),
      batch: {
        multicall: true,
      },
    })

    console.log(`[RPC] Using ${config.rpcUrl} + ${FREE_RPCS.length} fallback endpoints (custom transport, ${hasProxy ? 'proxied' : 'direct'})`)
  }
  return clientInstance
}
