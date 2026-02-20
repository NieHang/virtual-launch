'use client'

import type { ProjectState } from '@/lib/api'
import {
  formatPrice,
  formatNumber,
  formatPercentCeil,
  formatWei,
  formatUsd,
  weiToNumber,
} from '@/lib/format'

interface Props {
  state: ProjectState
}

export function KpiCards({ state }: Props) {
  // Always show USD as primary if available
  const hasUsd = state.virtualUsdPrice !== null && state.virtualUsdPrice > 0
  const tokenPriceV = state.spotPrice
  const tokenPriceUsd =
    hasUsd && tokenPriceV !== null ? tokenPriceV * (state.virtualUsdPrice || 0) : null

  const cards = [
    {
      label: hasUsd ? 'Token Price (USD/Token)' : 'Token Price (V/Token)',
      value:
        hasUsd && tokenPriceUsd !== null
          ? formatUsd(tokenPriceUsd)
          : formatPrice(tokenPriceV),
      sub:
        tokenPriceV !== null
          ? hasUsd && state.virtualUsdPrice !== null
            ? `${formatPrice(tokenPriceV)} V/token | 1 VIRTUAL = ${formatUsd(state.virtualUsdPrice)}`
            : `${formatPrice(tokenPriceV)} V/token`
          : '',
      color: 'text-white',
    },
    {
      label: 'FDV',
      value: hasUsd && state.fdvUsd !== null
        ? formatUsd(state.fdvUsd)
        : (state.fdv ? `${formatNumber(state.fdv)} V` : '-'),
      sub: hasUsd && state.efdvUsd !== null
        ? `EFDV: ${formatUsd(state.efdvUsd)}`
        : state.efdv
          ? `EFDV: ${formatNumber(state.efdv)} V`
          : '',
      color: 'text-[var(--accent)]',
    },
    {
      label: 'Tax Rate',
      value: formatPercentCeil(state.buyTaxRate),
      sub: 'Buy tax',
      color: 'text-yellow-400',
    },
    {
      label: 'Tax Collected',
      value: `${formatWei(state.totalTaxCollectedVirtual, 18, 2)} V`,
      sub: hasUsd
        ? `≈ ${formatUsd(weiToNumber(state.totalTaxCollectedVirtual) * (state.virtualUsdPrice || 0))}`
        : state.totalTaxCollectedToken !== '0'
          ? `+ ${formatWei(state.totalTaxCollectedToken, 18, 2)} TKN`
          : '',
      color: 'text-emerald-400',
    },
    {
      label: 'Phase',
      value: state.project.phase === 'EXTERNAL' ? 'Graduated' : 'Internal',
      sub:
        state.project.phase === 'INTERNAL'
          ? `${state.graduationProgress !== null ? `${(state.graduationProgress * 100).toFixed(1)}% to 42K V` : 'Progress unavailable'}${
              state.internalVirtualBalance
                ? ` | Pool V: ${formatWei(state.internalVirtualBalance, 18, 2)}`
                : ''
            }${state.internalMarketAddress ? ` | Pool: ${state.internalMarketAddress.slice(0, 8)}...${state.internalMarketAddress.slice(-6)}` : ''}`
          : hasUsd
            ? `1 VIRTUAL = ${formatUsd(state.virtualUsdPrice)}`
            : '',
      color:
        state.project.phase === 'EXTERNAL'
          ? 'text-green-400'
          : 'text-yellow-400',
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-4"
        >
          <p className="text-xs text-[var(--muted)] uppercase tracking-wide mb-1">
            {card.label}
          </p>
          <p className={`text-xl font-bold ${card.color}`}>{card.value}</p>
          {card.sub && (
            <p className="text-xs text-[var(--muted)] mt-1">{card.sub}</p>
          )}
        </div>
      ))}

      {/* Graduation progress bar */}
      {state.project.phase === 'INTERNAL' &&
        state.graduationProgress !== null && (
          <div className="col-span-full bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-[var(--muted)] uppercase tracking-wide">
                Graduation Progress
              </p>
              <p className="text-sm font-mono">
                {(state.graduationProgress * 100).toFixed(1)}%
              </p>
            </div>
            <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[var(--accent)] to-green-400 rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(state.graduationProgress * 100, 100)}%`,
                }}
              />
            </div>
          </div>
        )}
    </div>
  )
}
