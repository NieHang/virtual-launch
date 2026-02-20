/**
 * Fetch VIRTUAL/USD price from multiple APIs (all via proxy if configured).
 * Priority: Gate.io → DexScreener → CoinGecko → last known
 */

import { setVirtualUsdPrice, getVirtualUsdPrice, getVirtualUsdAge } from '../indexer/price-cache.js';
import { proxyFetch } from './proxy.js';

const GATEIO_URL = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=VIRTUAL_USDT';
const VIRTUAL_ADDRESS = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b';
const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${VIRTUAL_ADDRESS}`;
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=virtual-protocol&vs_currencies=usd';
const REFRESH_MS = 60_000; // refresh every 60s

let fetching = false;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await proxyFetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function fetchFromGateIo(): Promise<number | null> {
  try {
    const data = await fetchWithTimeout(GATEIO_URL, 10000);
    if (!Array.isArray(data) || data.length === 0) return null;
    const ticker = data[0];
    const price = parseFloat(ticker.last);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchFromDexScreener(): Promise<number | null> {
  try {
    const data = await fetchWithTimeout(DEXSCREENER_URL, 10000);
    if (!data?.pairs?.length) return null;

    const pairs = data.pairs as Array<{ priceUsd: string; liquidity?: { usd: number } }>;
    const sorted = pairs
      .filter((p) => p.priceUsd && parseFloat(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    if (sorted.length > 0) {
      return parseFloat(sorted[0].priceUsd);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFromCoinGecko(): Promise<number | null> {
  try {
    const data = await fetchWithTimeout(COINGECKO_URL, 10000);
    const price = data?.['virtual-protocol']?.usd;
    return typeof price === 'number' && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function refreshVirtualUsdPrice(): Promise<number | null> {
  if (fetching) return getVirtualUsdPrice();
  if (getVirtualUsdAge() < REFRESH_MS) return getVirtualUsdPrice();

  fetching = true;
  try {
    // Try Gate.io first (China-accessible without proxy)
    let price = await fetchFromGateIo();

    // Fallback to DexScreener (needs proxy in China)
    if (price === null) {
      price = await fetchFromDexScreener();
    }

    // Fallback to CoinGecko (needs proxy in China)
    if (price === null) {
      price = await fetchFromCoinGecko();
    }

    if (price !== null) {
      setVirtualUsdPrice(price);
      console.log(`[VirtualPrice] VIRTUAL = $${price.toFixed(4)}`);
      return price;
    }

    console.warn('[VirtualPrice] All sources failed, keeping last known price');
    return getVirtualUsdPrice();
  } catch {
    return getVirtualUsdPrice();
  } finally {
    fetching = false;
  }
}

/**
 * Start background loop that refreshes VIRTUAL/USD every 60s.
 */
export function startVirtualPriceLoop(): void {
  // Fetch immediately
  refreshVirtualUsdPrice().catch(() => {});

  // Then every 60s
  setInterval(() => {
    refreshVirtualUsdPrice().catch(() => {});
  }, REFRESH_MS);
}
