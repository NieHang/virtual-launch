export interface ThresholdProbabilityInput {
  targetMarketCapUsd: number
  currentMarketCapUsd: number | null
  remainingBuybackUsd: number
  buyTaxRate: number
  concentrationTop10: number
  buyMomentum: number
  sampleTrades: number
  horizonHours: number
}

export interface ThresholdProbabilityOutput {
  probability: number
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  factors: Array<{ name: string; value: number; contribution: number }>
  modelVersion: string
  trainedAt: string
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

export function computeThresholdProbability(
  input: ThresholdProbabilityInput,
): ThresholdProbabilityOutput {
  const ratioToTarget =
    input.currentMarketCapUsd && input.currentMarketCapUsd > 0
      ? input.targetMarketCapUsd / input.currentMarketCapUsd
      : 10
  const buybackCoverage = input.targetMarketCapUsd > 0
    ? input.remainingBuybackUsd / input.targetMarketCapUsd
    : 0

  // Explainable baseline model (hand-tuned coefficients, versioned)
  const cIntercept = -1.15
  const cTargetGap = -1.2 * Math.log(Math.max(1, ratioToTarget))
  const cBuyback = 2.1 * Math.min(1.5, Math.max(0, buybackCoverage))
  const cMomentum = 1.8 * Math.max(-1, Math.min(1, input.buyMomentum))
  const cConcentration = -1.1 * Math.max(0, Math.min(1, input.concentrationTop10))
  const cTaxDrag = -0.8 * Math.max(0, Math.min(1, input.buyTaxRate))
  const cHorizonBoost = Math.log(Math.max(1, input.horizonHours / 24)) * 0.35

  const logit =
    cIntercept +
    cTargetGap +
    cBuyback +
    cMomentum +
    cConcentration +
    cTaxDrag +
    cHorizonBoost

  const probability = Math.max(0.01, Math.min(0.99, sigmoid(logit)))
  const confidence: 'LOW' | 'MEDIUM' | 'HIGH' =
    input.sampleTrades >= 300 ? 'HIGH' : input.sampleTrades >= 80 ? 'MEDIUM' : 'LOW'

  return {
    probability,
    confidence,
    modelVersion: 'threshold-v1.0-baseline',
    trainedAt: new Date().toISOString(),
    factors: [
      { name: 'target_gap', value: ratioToTarget, contribution: cTargetGap },
      { name: 'buyback_coverage', value: buybackCoverage, contribution: cBuyback },
      { name: 'buy_momentum', value: input.buyMomentum, contribution: cMomentum },
      { name: 'top10_concentration', value: input.concentrationTop10, contribution: cConcentration },
      { name: 'buy_tax_rate', value: input.buyTaxRate, contribution: cTaxDrag },
      { name: 'horizon_hours', value: input.horizonHours, contribution: cHorizonBoost },
    ],
  }
}
