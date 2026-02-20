import { type Address, getAddress } from 'viem';
import { getClient } from '../chain/client.js';
import { fetchTransferLogs, parseTransferLogs, isContract, withRetry, sleep } from '../chain/utils.js';
import { VIRTUAL_ADDRESS, TOKEN_ABI } from '../chain/constants.js';
import { config } from '../config.js';
import {
  LAUNCH_PATH_NET_ADDRESS,
  LAUNCH_PATH_TAX_ADDRESS,
} from './launch-path-parser.js';

interface CandidateScore {
  address: Address;
  tokenTransferTouches: number;
  virtualTransferTouches: number;
  virtualTransferTouchesCapped: number;
  launchPathVirtualTouches: number;
  launchPathDistinctTxCount: number;
  launchPathCorrelatedTxCount: number;
  distinctTxCount: number;
  tokenBalance: bigint;
  virtualBalance: bigint;
  score: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function readMarketAddressFromTokenContract(
  tokenAddress: Address,
  functionName: 'pairToken' | 'uniswapV2Pair',
): Promise<Address | null> {
  const client = getClient();
  try {
    const raw = (await client.readContract({
      address: tokenAddress,
      abi: TOKEN_ABI,
      functionName,
    })) as string;
    const normalized = getAddress(raw) as Address;
    const lower = normalized.toLowerCase();
    if (
      lower === ZERO_ADDRESS ||
      lower === getAddress(tokenAddress).toLowerCase() ||
      lower === getAddress(VIRTUAL_ADDRESS as Address).toLowerCase()
    ) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Prefer deterministic on-chain hints from token contract over heuristics.
 * Returns first valid market candidate that is a contract and holds both TOKEN+VIRTUAL.
 */
export async function discoverInternalMarketFromTokenContract(
  tokenAddress: Address,
): Promise<Address | null> {
  const client = getClient();
  const directCandidates = [
    await readMarketAddressFromTokenContract(tokenAddress, 'pairToken'),
    await readMarketAddressFromTokenContract(tokenAddress, 'uniswapV2Pair'),
  ].filter((x): x is Address => Boolean(x));

  const seen = new Set<string>();
  for (const candidate of directCandidates) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    try {
      const isCandidateContract = await withRetry(
        () => isContract(candidate),
        3,
        500,
      );
      if (!isCandidateContract) continue;

      const [tokenBal, virtualBal] = await Promise.all([
        withRetry(
          () =>
            client.readContract({
              address: tokenAddress,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [candidate],
            }) as Promise<bigint>,
          3,
          500,
        ),
        withRetry(
          () =>
            client.readContract({
              address: VIRTUAL_ADDRESS as Address,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [candidate],
            }) as Promise<bigint>,
          3,
          500,
        ),
      ]);

      if (tokenBal > 0n && virtualBal > 0n) {
        return candidate;
      }
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

/**
 * Auto-discover the internal market (bonding curve) contract address
 * using Transfer event frequency analysis.
 *
 * Algorithm:
 * 1. Fetch first ~2000 token Transfer logs from firstActiveBlock
 * 2. Count frequency of each from/to address as counterparty
 * 3. Take top K by frequency, filter to contracts only
 * 4. For each candidate, count appearances in VIRTUAL Transfer logs
 * 5. Score and return the highest-scoring candidate
 */
export async function discoverInternalMarket(
  tokenAddress: Address,
  firstActiveBlock: number,
): Promise<{ marketAddress: Address; endBlock: number } | null> {
  const client = getClient();

  console.log(`[MarketDiscovery] Starting discovery for ${tokenAddress} from block ${firstActiveBlock}`);

  // Step 1: Fetch token Transfer logs
  // We'll scan a reasonable range to get ~2000 logs
  let currentBlock = firstActiveBlock;
  const latestBlock = Number(await client.getBlockNumber());
  let allTokenLogs: ReturnType<typeof parseTransferLogs> = [];
  let scanEnd = firstActiveBlock;

  const batchSize = 10_000; // blocks per batch
  while (allTokenLogs.length < config.transferBatchSize && currentBlock <= latestBlock) {
    const to = Math.min(currentBlock + batchSize, latestBlock);
    const rawLogs = await fetchTransferLogs(tokenAddress, BigInt(currentBlock), BigInt(to));
    const parsed = parseTransferLogs(rawLogs);
    allTokenLogs = allTokenLogs.concat(parsed);
    scanEnd = to;
    currentBlock = to + 1;

    if (allTokenLogs.length >= config.transferBatchSize) break;
  }

  if (allTokenLogs.length === 0) {
    console.warn('[MarketDiscovery] No Transfer logs found');
    return null;
  }

  console.log(`[MarketDiscovery] Collected ${allTokenLogs.length} token Transfer logs up to block ${scanEnd}`);

  // Step 2: Count counterparty frequency
  const freq = new Map<string, number>();
  const txSets = new Map<string, Set<string>>();

  for (const log of allTokenLogs) {
    for (const addr of [log.from, log.to]) {
      freq.set(addr, (freq.get(addr) || 0) + 1);
      if (!txSets.has(addr)) txSets.set(addr, new Set());
      txSets.get(addr)!.add(log.txHash);
    }
  }

  // Step 3: Top K candidates, filter to contracts
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.marketCandidateTopK);

  console.log(`[MarketDiscovery] Top ${sorted.length} candidates by frequency`);

  // Check contracts in small batches to avoid rate limiting
  const contractChecks: Array<{ addr: string; isContract: boolean }> = [];
  const checkBatch = 5;
  for (let i = 0; i < sorted.length; i += checkBatch) {
    const batch = sorted.slice(i, i + checkBatch);
    const results = await Promise.all(
      batch.map(async ([addr]) => {
        try {
          return {
            addr: getAddress(addr),
            isContract: await withRetry(() => isContract(getAddress(addr) as Address), 3, 1000),
          };
        } catch {
          return { addr: getAddress(addr), isContract: false };
        }
      }),
    );
    contractChecks.push(...results);
    if (i + checkBatch < sorted.length) await sleep(100);
  }

  const contractCandidates = contractChecks
    .filter((c) => c.isContract)
    .map((c) => c.addr)
    .filter((addr) => {
      const a = addr.toLowerCase()
      return (
        a !== getAddress(tokenAddress).toLowerCase() &&
        a !== getAddress(VIRTUAL_ADDRESS as Address).toLowerCase() &&
        a !== '0x0000000000000000000000000000000000000000'
      )
    });

  console.log(`[MarketDiscovery] ${contractCandidates.length} are contracts`);

  if (contractCandidates.length === 0) {
    console.warn('[MarketDiscovery] No contract candidates found');
    return null;
  }

  // Step 3.5: keep only addresses with non-zero TOKEN and VIRTUAL balances.
  // A real internal market should hold both assets.
  const liquidCandidates: Address[] = [];
  const liquidityMap = new Map<string, { tokenBalance: bigint; virtualBalance: bigint }>();
  for (const addr of contractCandidates) {
    try {
      const [tokenBal, virtualBal] = await Promise.all([
        withRetry(
          () =>
            client.readContract({
              address: tokenAddress,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [addr as Address],
            }) as Promise<bigint>,
          3,
          500,
        ),
        withRetry(
          () =>
            client.readContract({
              address: VIRTUAL_ADDRESS as Address,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [addr as Address],
            }) as Promise<bigint>,
          3,
          500,
        ),
      ]);

      liquidityMap.set(addr.toLowerCase(), {
        tokenBalance: tokenBal,
        virtualBalance: virtualBal,
      });

      if (tokenBal > 0n && virtualBal > 0n) {
        liquidCandidates.push(addr as Address);
      }
    } catch {
      // skip candidate
    }
  }

  if (liquidCandidates.length > 0) {
    console.log(
      `[MarketDiscovery] ${liquidCandidates.length} candidates have non-zero TOKEN+VIRTUAL balances`,
    );
  } else {
    console.warn(
      `[MarketDiscovery] No liquid candidates found, falling back to frequency-only candidates`,
    );
  }

  const finalCandidates = liquidCandidates.length > 0 ? liquidCandidates : contractCandidates;

  // Step 4: Check VIRTUAL Transfer correlation
  // VIRTUAL is a high-traffic token, so we fetch in small batches with retry
  // We only need to check transactions that our candidates appear in,
  // so we can use a targeted approach: filter by candidate tx hashes
  console.log(`[MarketDiscovery] Fetching VIRTUAL Transfer logs in batches...`);

  let parsedVirtualLogs: ReturnType<typeof parseTransferLogs> = [];
  const virtualBatchSize = 2_000; // smaller batches for VIRTUAL (high traffic)
  let vBlock = firstActiveBlock;

  while (vBlock <= scanEnd) {
    const vEnd = Math.min(vBlock + virtualBatchSize, scanEnd);
    try {
      const rawVLogs = await withRetry(
        () => fetchTransferLogs(VIRTUAL_ADDRESS as Address, BigInt(vBlock), BigInt(vEnd)),
        5,   // more retries for VIRTUAL
        2000, // longer base delay
      );
      parsedVirtualLogs = parsedVirtualLogs.concat(parseTransferLogs(rawVLogs));
    } catch (err) {
      console.warn(`[MarketDiscovery] Failed to fetch VIRTUAL logs [${vBlock}-${vEnd}], skipping batch`);
    }
    vBlock = vEnd + 1;
    // Small delay between batches to avoid rate limiting
    await sleep(200);
  }

  console.log(`[MarketDiscovery] Fetched ${parsedVirtualLogs.length} VIRTUAL Transfer logs`);

  const launchPathAddressSet = new Set<string>([
    LAUNCH_PATH_NET_ADDRESS.toLowerCase(),
    LAUNCH_PATH_TAX_ADDRESS.toLowerCase(),
  ]);
  const candidateSet = new Set<string>(finalCandidates.map((a) => a.toLowerCase()));
  const launchPathVirtualTxHashes = new Set<string>();
  const virtualFreq = new Map<string, number>();
  const launchPathVirtualTouches = new Map<string, number>();
  const launchPathTxSets = new Map<string, Set<string>>();
  for (const log of parsedVirtualLogs) {
    for (const addr of [log.from, log.to]) {
      virtualFreq.set(addr, (virtualFreq.get(addr) || 0) + 1);
    }

    const fromLower = log.from.toLowerCase();
    const toLower = log.to.toLowerCase();
    const fromIsLaunch = launchPathAddressSet.has(fromLower);
    const toIsLaunch = launchPathAddressSet.has(toLower);
    if (!fromIsLaunch && !toIsLaunch) continue;
    launchPathVirtualTxHashes.add(log.txHash);

    const counterparty = fromIsLaunch ? toLower : fromLower;
    if (!candidateSet.has(counterparty)) continue;

    launchPathVirtualTouches.set(
      counterparty,
      (launchPathVirtualTouches.get(counterparty) || 0) + 1,
    );
    if (!launchPathTxSets.has(counterparty)) {
      launchPathTxSets.set(counterparty, new Set<string>());
    }
    launchPathTxSets.get(counterparty)!.add(log.txHash);
  }

  // Step 5: Score candidates
  const weights = config.scoringWeights;
  const scores: CandidateScore[] = finalCandidates
    .map((addr) => {
    const tokenTouches = freq.get(addr) || 0;
    const virtualTouches = virtualFreq.get(addr) || 0;
    // Anti-noise guard: high-traffic infra/router contracts often have
    // disproportionately large VIRTUAL touch count relative to token touches.
    // Cap VIRTUAL contribution so "real pool" token-side signal dominates.
    const virtualTouchesCapped = Math.min(
      virtualTouches,
      Math.max(tokenTouches * 3, 0),
    );
    const launchVirtualTouches = launchPathVirtualTouches.get(addr.toLowerCase()) || 0;
    const launchDistinctTx = launchPathTxSets.get(addr.toLowerCase())?.size || 0;
    const candidateTxHashes = txSets.get(addr);
    const distinctTx = candidateTxHashes?.size || 0;
    let launchCorrelatedTx = 0;
    if (candidateTxHashes && launchPathVirtualTxHashes.size > 0) {
      for (const txHash of candidateTxHashes) {
        if (launchPathVirtualTxHashes.has(txHash)) launchCorrelatedTx += 1;
      }
    }
      const liq = liquidityMap.get(addr.toLowerCase()) || {
        tokenBalance: 0n,
        virtualBalance: 0n,
      };

    const score =
      weights.tokenTransferTouches * tokenTouches +
      weights.virtualTransferTouches * virtualTouchesCapped +
        weights.distinctTxCount * distinctTx +
        // Launch-path priority: if a candidate directly transacts VIRTUAL with
        // known launch path addresses, it is much more likely to be the
        // internal pool than generic high-traffic contracts.
        (launchCorrelatedTx > 0 || launchDistinctTx > 0
          ? 5000 +
            launchCorrelatedTx * 120 +
            launchDistinctTx * 50 +
            launchVirtualTouches * 10
          : 0) +
        // small bonus for addresses that actually hold both assets
        (liq.tokenBalance > 0n && liq.virtualBalance > 0n ? 1000 : 0);

      return {
        address: addr as Address,
        tokenTransferTouches: tokenTouches,
        virtualTransferTouches: virtualTouches,
        virtualTransferTouchesCapped: virtualTouchesCapped,
        launchPathVirtualTouches: launchVirtualTouches,
        launchPathDistinctTxCount: launchDistinctTx,
        launchPathCorrelatedTxCount: launchCorrelatedTx,
        distinctTxCount: distinctTx,
        tokenBalance: liq.tokenBalance,
        virtualBalance: liq.virtualBalance,
        score,
      };
    })
    // Internal market should touch both token and VIRTUAL flows.
    .filter((s) => s.tokenTransferTouches > 0 && s.virtualTransferTouches > 0);

  scores.sort((a, b) => b.score - a.score);

  // Log top 5 for debugging
  console.log('[MarketDiscovery] Top 5 candidates:');
  for (const s of scores.slice(0, 5)) {
    console.log(
      `  ${s.address}: score=${s.score} (token=${s.tokenTransferTouches}, virtual=${s.virtualTransferTouches}, virtualCapped=${s.virtualTransferTouchesCapped}, launchVirtual=${s.launchPathVirtualTouches}, launchTx=${s.launchPathDistinctTxCount}, launchCorrTx=${s.launchPathCorrelatedTxCount}, tx=${s.distinctTxCount}, tokenBal=${s.tokenBalance}, virtualBal=${s.virtualBalance})`,
    );
  }

  const launchPriority = scores
    .filter(
      (s) =>
        s.launchPathCorrelatedTxCount > 0 || s.launchPathDistinctTxCount > 0,
    )
    .sort((a, b) => {
      if (b.launchPathCorrelatedTxCount !== a.launchPathCorrelatedTxCount) {
        return b.launchPathCorrelatedTxCount - a.launchPathCorrelatedTxCount;
      }
      if (b.launchPathDistinctTxCount !== a.launchPathDistinctTxCount) {
        return b.launchPathDistinctTxCount - a.launchPathDistinctTxCount;
      }
      if (b.tokenTransferTouches !== a.tokenTransferTouches) {
        return b.tokenTransferTouches - a.tokenTransferTouches;
      }
      if (b.distinctTxCount !== a.distinctTxCount) {
        return b.distinctTxCount - a.distinctTxCount;
      }
      return b.score - a.score;
    });

  if (launchPriority.length > 0) {
    console.log('[MarketDiscovery] Launch-path priority candidates (top 3):');
    for (const s of launchPriority.slice(0, 3)) {
      console.log(
        `  ${s.address}: launchCorrTx=${s.launchPathCorrelatedTxCount}, launchTx=${s.launchPathDistinctTxCount}, token=${s.tokenTransferTouches}, score=${s.score}`,
      );
    }
  }

  const winner = launchPriority[0] || scores[0];
  if (!winner || winner.score === 0) {
    console.warn('[MarketDiscovery] No valid candidate found');
    return null;
  }

  console.log(`[MarketDiscovery] Internal market discovered: ${winner.address} (score=${winner.score})`);

  return {
    marketAddress: winner.address,
    endBlock: scanEnd,
  };
}
