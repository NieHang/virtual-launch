export interface LocalLayeredEfdvRow {
  taxRate: number
  impliedFdv: number
  impliedEfdv: number
  breakevenMultiple: number
}

export interface LocalLayeredEfdvResult {
  basePrice: number
  taxModel: 'LINEAR_99_TO_1'
  prebuyRatio: number
  prebuyMultiplier: number
  layers: LocalLayeredEfdvRow[]
}

export function buildDecayTaxLayers(): number[] {
  const rows: number[] = []
  for (let bps = 9900; bps >= 100; bps -= 100) {
    rows.push(bps / 10000)
  }
  return rows
}

export function normalizePrebuyRatio(prebuyRatio: number): number {
  if (!Number.isFinite(prebuyRatio)) return 0
  if (prebuyRatio <= 0) return 0
  if (prebuyRatio >= 0.99) return 0.99
  return prebuyRatio
}

export function derivePrebuyMultiplier(prebuyRatio: number): number {
  const normalizedRatio = normalizePrebuyRatio(prebuyRatio)
  return normalizedRatio < 1 ? 1 / (1 - normalizedRatio) : 1
}

export function deriveLaunchCurveBasePrice(totalSupplyTokens: number): number {
  if (!Number.isFinite(totalSupplyTokens) || totalSupplyTokens <= 0) return 0
  const graduationTargetVirtual = 42_000
  return graduationTargetVirtual / totalSupplyTokens
}

export function computeFdvEfdv(
  spotPrice: number,
  totalSupplyTokens: number,
  buyTaxRate: number,
  prebuyRatio = 0,
): { fdv: number; efdv: number } {
  const prebuyMultiplier = derivePrebuyMultiplier(prebuyRatio)
  const fdv = spotPrice * totalSupplyTokens * prebuyMultiplier
  return {
    fdv,
    efdv: buyTaxRate < 1 ? fdv / (1 - buyTaxRate) : fdv,
  }
}

export function computeLayeredEfdv(
  totalSupplyTokens: number,
  basePrice: number,
  prebuyRatio = 0,
  taxRates: number[] = buildDecayTaxLayers(),
): LocalLayeredEfdvResult {
  const normalizedPrebuyRatio = normalizePrebuyRatio(prebuyRatio)
  const prebuyMultiplier = derivePrebuyMultiplier(normalizedPrebuyRatio)
  const layers = taxRates.map((taxRate) => {
    const { fdv, efdv } = computeFdvEfdv(basePrice, totalSupplyTokens, taxRate, normalizedPrebuyRatio)
    return {
      taxRate,
      impliedFdv: fdv,
      impliedEfdv: efdv,
      breakevenMultiple: taxRate < 1 ? 1 / (1 - taxRate) : 1,
    }
  })

  return {
    basePrice,
    taxModel: 'LINEAR_99_TO_1',
    prebuyRatio: normalizedPrebuyRatio,
    prebuyMultiplier,
    layers,
  }
}
