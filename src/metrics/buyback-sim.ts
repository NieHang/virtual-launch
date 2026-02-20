import type { BuybackSimulation } from '../types.js';
import type { DumpSimulationResult } from '../types.js';

/**
 * Simulate a distributed buyback using constant-product AMM math.
 *
 * @param reserve0 - Current reserve of token0 in the pair
 * @param reserve1 - Current reserve of token1 in the pair
 * @param isToken0 - Whether the project token is token0
 * @param amountPerStep - VIRTUAL buyback amount per interval (in wei)
 * @param totalTaxInput - Total tax budget used for buyback (in wei)
 * @param stepIntervalSeconds - Seconds between steps (for display only)
 */
export function simulateBuyback(
  reserve0: bigint,
  reserve1: bigint,
  isToken0: boolean,
  amountPerStep: bigint,
  totalTaxInput: bigint,
  stepIntervalSeconds: number = 60,
  mode: 'IDEAL' | 'REALISTIC' = 'IDEAL',
  spotPriceAnchor: number | null = null,
): BuybackSimulation {
  const sellPressureBpsPerStep = mode === 'REALISTIC' ? 3000 : 0

  if (
    amountPerStep === 0n ||
    totalTaxInput === 0n ||
    reserve0 === 0n ||
    reserve1 === 0n
  ) {
    return {
      budget: '0',
      amountPerStep: amountPerStep.toString(),
      remainderAmount: '0',
      steps: 0,
      stepIntervalSeconds,
      totalTokensBought: '0',
      avgPrice: 0,
      maxSlippage: 0,
      initialPrice: 0,
      priceTrajectory: [],
      finalPrice: 0,
      priceImpactPercent: 0,
      reserveVirtual: '0',
      reserveToken: '0',
      assumptions: {
        noExternalSells: mode === 'IDEAL',
        useCurrentLpReserves: true,
        mode,
        sellPressureBpsPerStep,
        priceAnchor: 'RESERVE',
        spotPriceAnchor: null,
      },
    };
  }

  // Determine which reserve is VIRTUAL and which is TOKEN
  let reserveVirtual = isToken0 ? reserve1 : reserve0;
  let reserveToken = isToken0 ? reserve0 : reserve1;

  let totalTokensBought = 0n;
  let totalSpent = 0n;
  let maxSlippage = 0;
  const fullSteps = totalTaxInput / amountPerStep;
  const remainderAmount = totalTaxInput % amountPerStep;
  const steps = Number(fullSteps + (remainderAmount > 0n ? 1n : 0n));

  const initialPriceRaw = Number(reserveVirtual) / Number(reserveToken);
  const shouldAnchor =
    typeof spotPriceAnchor === 'number' &&
    Number.isFinite(spotPriceAnchor) &&
    spotPriceAnchor > 0 &&
    initialPriceRaw > 0;
  const priceScale = shouldAnchor ? spotPriceAnchor / initialPriceRaw : 1;
  const initialPrice = initialPriceRaw * priceScale;
  const trajectory: Array<{ step: number; price: number; tokensBought: string; elapsed: string }> = [];

  for (let i = 0; i < steps; i++) {
    const buyAmount =
      i === steps - 1 && remainderAmount > 0n ? remainderAmount : amountPerStep;

    // Constant product: tokenOut = reserveToken - (reserveVirtual * reserveToken) / (reserveVirtual + amount)
    const k = reserveVirtual * reserveToken;
    const newReserveVirtual = reserveVirtual + buyAmount;
    const newReserveToken = k / newReserveVirtual;
    const tokenOut = reserveToken - newReserveToken;

    if (tokenOut <= 0n) continue;

    totalTokensBought += tokenOut;
    totalSpent += buyAmount;

    // Update reserves for next step
    reserveVirtual = newReserveVirtual;
    reserveToken = newReserveToken;

    // Realistic mode: apply external sell pressure after each buyback.
    // This dampens the theoretical pump by simulating immediate market sells.
    if (sellPressureBpsPerStep > 0 && tokenOut > 0n) {
      const sellIn = (tokenOut * BigInt(sellPressureBpsPerStep)) / 10000n;
      if (sellIn > 0n) {
        const kAfterBuy = reserveVirtual * reserveToken;
        const postSellReserveToken = reserveToken + sellIn;
        const postSellReserveVirtual = kAfterBuy / postSellReserveToken;
        reserveVirtual = postSellReserveVirtual;
        reserveToken = postSellReserveToken;
      }
    }

    const currentPriceRaw = Number(reserveVirtual) / Number(reserveToken);
    const currentPrice = currentPriceRaw * priceScale;
    const slippage = (currentPriceRaw - initialPriceRaw) / initialPriceRaw;
    if (slippage > maxSlippage) maxSlippage = slippage;

    // Format elapsed time
    const elapsedSeconds = (i + 1) * stepIntervalSeconds;
    let elapsed: string;
    if (elapsedSeconds < 60) {
      elapsed = `${elapsedSeconds}s`;
    } else if (elapsedSeconds < 3600) {
      elapsed = `${Math.floor(elapsedSeconds / 60)}m${elapsedSeconds % 60 ? (elapsedSeconds % 60) + 's' : ''}`;
    } else {
      elapsed = `${(elapsedSeconds / 3600).toFixed(1)}h`;
    }

    trajectory.push({
      step: i + 1,
      price: currentPrice,
      tokensBought: tokenOut.toString(),
      elapsed,
    });
  }

  const finalPriceRaw = Number(reserveVirtual) / Number(reserveToken);
  const finalPrice = finalPriceRaw * priceScale;
  const avgPriceRaw =
    totalTokensBought > 0n
      ? Number(totalSpent) / Number(totalTokensBought)
      : 0;
  const avgPrice = avgPriceRaw * priceScale;

  const priceImpactPercent =
    initialPriceRaw > 0
      ? ((finalPriceRaw - initialPriceRaw) / initialPriceRaw) * 100
      : 0;

  return {
    budget: totalSpent.toString(),
    amountPerStep: amountPerStep.toString(),
    remainderAmount: remainderAmount.toString(),
    steps,
    stepIntervalSeconds,
    totalTokensBought: totalTokensBought.toString(),
    avgPrice,
    maxSlippage,
    initialPrice,
    priceTrajectory: trajectory,
    finalPrice,
    priceImpactPercent,
    reserveVirtual: reserveVirtual.toString(),
    reserveToken: reserveToken.toString(),
    assumptions: {
      noExternalSells: mode === 'IDEAL',
      useCurrentLpReserves: true,
      mode,
      sellPressureBpsPerStep,
      priceAnchor: shouldAnchor ? 'SPOT' : 'RESERVE',
      spotPriceAnchor: shouldAnchor ? spotPriceAnchor : null,
    },
  };
}

/**
 * Simulate a one-shot dump (TOKEN -> VIRTUAL) using constant-product AMM math.
 */
export function simulateDump(
  reserveVirtual: bigint,
  reserveToken: bigint,
  sellAmountToken: bigint,
): DumpSimulationResult {
  if (reserveVirtual <= 0n || reserveToken <= 0n || sellAmountToken <= 0n) {
    return {
      reserveVirtual: reserveVirtual.toString(),
      reserveToken: reserveToken.toString(),
      sellAmountToken: sellAmountToken.toString(),
      virtualOut: '0',
      initialPrice: 0,
      finalPrice: 0,
      priceImpactPercent: 0,
      requiredBuybackVirtual: '0',
    };
  }

  const k = reserveVirtual * reserveToken;
  const newReserveToken = reserveToken + sellAmountToken;
  const newReserveVirtual = k / newReserveToken;
  const virtualOut = reserveVirtual > newReserveVirtual ? reserveVirtual - newReserveVirtual : 0n;

  const initialPrice = Number(reserveVirtual) / Number(reserveToken);
  const finalPrice = Number(newReserveVirtual) / Number(newReserveToken);
  const priceImpactPercent =
    initialPrice > 0 ? ((finalPrice - initialPrice) / initialPrice) * 100 : 0;

  // Approximate buyback required to restore original price ratio.
  const requiredBuybackVirtual =
    newReserveVirtual < reserveVirtual ? reserveVirtual - newReserveVirtual : 0n;

  return {
    reserveVirtual: reserveVirtual.toString(),
    reserveToken: reserveToken.toString(),
    sellAmountToken: sellAmountToken.toString(),
    virtualOut: virtualOut.toString(),
    initialPrice,
    finalPrice,
    priceImpactPercent,
    requiredBuybackVirtual: requiredBuybackVirtual.toString(),
  };
}
