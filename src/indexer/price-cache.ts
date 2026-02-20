/**
 * In-memory price cache updated by the indexer loop.
 * The API reads from here instead of making RPC calls.
 */

interface PriceState {
  spotPrice: number | null;       // VIRTUAL per token
  virtualUsdPrice: number | null; // USD per VIRTUAL
  reserveVirtual: bigint;
  reserveToken: bigint;
  isToken0: boolean;
  updatedAt: number;
}

interface GradCacheEntry {
  token0: string;
  token1: string;
  isToken0: boolean; // whether project token is token0
  pairAddress: string;
  cachedAt: number;
}

const priceStates = new Map<string, PriceState>();
const gradCache = new Map<string, GradCacheEntry>();

// VIRTUAL/USD price (shared across all projects)
let virtualUsdPrice: number | null = null;
let virtualUsdLastFetch = 0;

export function setVirtualUsdPrice(price: number): void {
  virtualUsdPrice = price;
  virtualUsdLastFetch = Date.now();
}

export function getVirtualUsdPrice(): number | null {
  return virtualUsdPrice;
}

export function getVirtualUsdAge(): number {
  return Date.now() - virtualUsdLastFetch;
}

export function setCachedGradInfo(
  projectId: string,
  token0: string,
  token1: string,
  isToken0: boolean,
  pairAddress: string,
): void {
  gradCache.set(projectId, {
    token0,
    token1,
    isToken0,
    pairAddress,
    cachedAt: Date.now(),
  });
}

export function getCachedGradInfo(projectId: string): GradCacheEntry | null {
  return gradCache.get(projectId) || null;
}

export function updatePriceState(
  projectId: string,
  spotPrice: number | null,
  reserveVirtual: bigint,
  reserveToken: bigint,
  isToken0: boolean,
): void {
  priceStates.set(projectId, {
    spotPrice,
    virtualUsdPrice,
    reserveVirtual,
    reserveToken,
    isToken0,
    updatedAt: Date.now(),
  });
}

export function updateSpotPriceFromTrade(
  projectId: string,
  price: number,
): void {
  const existing = priceStates.get(projectId);
  if (existing) {
    existing.spotPrice = price;
    existing.virtualUsdPrice = virtualUsdPrice;
    existing.updatedAt = Date.now();
  } else {
    priceStates.set(projectId, {
      spotPrice: price,
      virtualUsdPrice,
      reserveVirtual: 0n,
      reserveToken: 0n,
      isToken0: false,
      updatedAt: Date.now(),
    });
  }
}

export function getPriceState(projectId: string): PriceState | null {
  return priceStates.get(projectId) || null;
}
