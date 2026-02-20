'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api, type ProjectState } from '@/lib/api'
import { useWebSocket } from '@/lib/ws'
import { KpiCards } from '@/components/KpiCards'
import { TradesFeed } from '@/components/TradesFeed'
import { WhaleTable } from '@/components/WhaleTable'
import { CostDistribution } from '@/components/CostDistribution'
import { BuybackSimulator } from '@/components/BuybackSimulator'
import { LargeOrders } from '@/components/LargeOrders'
import { WhaleActivityPanel } from '@/components/WhaleActivityPanel'
import { WhalePressure } from '@/components/WhalePressure'
import { InternalWhaleProfilePanel } from '@/components/InternalWhaleProfile'
import { CollapsibleSection } from '@/components/CollapsibleSection'
import { EfdvLayersPanel } from '@/components/EfdvLayersPanel'
import { ThresholdProbabilityPanel } from '@/components/ThresholdProbabilityPanel'

export default function ProjectPage() {
  const params = useParams()
  const projectId = params.id as string

  const [state, setState] = useState<ProjectState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { lastEvent, connected } = useWebSocket(projectId)

  // Initial load
  useEffect(() => {
    api
      .getProjectState(projectId)
      .then(setState)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [projectId])

  // Auto-refresh state every 10s (cheap: reads from in-memory cache, no RPC)
  useEffect(() => {
    const interval = setInterval(() => {
      api.getProjectState(projectId).then(setState).catch(console.error)
    }, 10_000)
    return () => clearInterval(interval)
  }, [projectId])

  // Update on WebSocket state events
  useEffect(() => {
    if (lastEvent?.type === 'state') {
      // Partial update - refetch full state
      api.getProjectState(projectId).then(setState).catch(console.error)
    }
  }, [lastEvent, projectId])

  if (loading) {
    return (
      <div className="text-center py-20 text-[var(--muted)]">
        Loading project...
      </div>
    )
  }

  if (error || !state) {
    return (
      <div className="text-center py-20">
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 max-w-md mx-auto text-red-400">
          {error || 'Project not found'}
        </div>
        <Link
          href="/"
          className="text-[var(--accent)] mt-4 inline-block hover:underline"
        >
          Back to projects
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-[var(--muted)] hover:text-white transition-colors"
            >
              Projects
            </Link>
            <span className="text-[var(--muted)]">/</span>
            <h1 className="text-2xl font-bold">{state.project.name}</h1>
          </div>
          <p className="text-sm text-[var(--muted)] font-mono mt-1">
            {state.project.tokenAddress}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? 'bg-green-400' : 'bg-red-400'
            }`}
          />
          <span className="text-xs text-[var(--muted)]">
            {connected ? 'Live' : 'Reconnecting...'}
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      <KpiCards state={state} />

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Trades */}
        <CollapsibleSection
          title="Recent Trades"
          subtitle="Long list | collapsed by default"
          defaultExpanded={false}
          storageKey={`project:${projectId}:section:recent-trades`}
        >
          <TradesFeed projectId={projectId} virtualUsdPrice={state.virtualUsdPrice} />
        </CollapsibleSection>

        {/* Right: Whales + Cost */}
        <div className="space-y-6">
          <CollapsibleSection
            title="Top Holders"
            subtitle="EOA only | Transfer-only hidden by default | Buyback excluded"
            defaultExpanded={false}
            storageKey={`project:${projectId}:section:top-holders`}
          >
            <WhaleTable projectId={projectId} virtualUsdPrice={state.virtualUsdPrice} />
          </CollapsibleSection>
          <CostDistribution projectId={projectId} spotPrice={state.spotPrice} virtualUsdPrice={state.virtualUsdPrice} />
        </div>
      </div>

      {/* Large Orders - Full width */}
      <CollapsibleSection
        title="Large Buy Orders"
        subtitle="Long list | collapsed by default"
        defaultExpanded={false}
        storageKey={`project:${projectId}:section:large-orders`}
      >
        <LargeOrders projectId={projectId} virtualUsdPrice={state.virtualUsdPrice} />
      </CollapsibleSection>

      {/* Whale live stream */}
      <CollapsibleSection
        title="Whale Live Activity"
        subtitle="Grouped by address | EOA only | Buyback excluded"
        defaultExpanded={false}
        storageKey={`project:${projectId}:section:whale-live-activity`}
      >
        <WhaleActivityPanel
          projectId={projectId}
          virtualUsdPrice={state.virtualUsdPrice}
          lastEvent={lastEvent}
        />
      </CollapsibleSection>

      {/* Internal whale profile */}
      <CollapsibleSection
        title="Whale Profile"
        subtitle="Internal/External buy breakdown | EOA only | Buyback excluded"
        defaultExpanded={false}
        storageKey={`project:${projectId}:section:whale-profile`}
      >
        <InternalWhaleProfilePanel
          projectId={projectId}
          virtualUsdPrice={state.virtualUsdPrice}
        />
      </CollapsibleSection>

      {/* Whale pressure and absorption */}
      <CollapsibleSection
        title="Whale Sell Pressure"
        subtitle="Concentration analysis | Dump simulation | Absorption check"
        defaultExpanded={false}
        storageKey={`project:${projectId}:section:whale-sell-pressure`}
      >
        <WhalePressure projectId={projectId} virtualUsdPrice={state.virtualUsdPrice} />
      </CollapsibleSection>

      <CollapsibleSection
        title="EFDV Layers"
        subtitle="Prelaunch / Live layered breakeven valuation"
        defaultExpanded={false}
        storageKey={`project:${projectId}:section:efdv-layers`}
      >
        <EfdvLayersPanel projectId={projectId} virtualUsdPrice={state.virtualUsdPrice} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Market Cap Threshold Probability"
        subtitle="Buyback-window probability estimate"
        defaultExpanded={false}
        storageKey={`project:${projectId}:section:threshold-probability`}
      >
        <ThresholdProbabilityPanel projectId={projectId} />
      </CollapsibleSection>

      {/* Buyback Simulator - Full width */}
      <BuybackSimulator
        projectId={projectId}
        phase={state.project.phase}
        virtualUsdPrice={state.virtualUsdPrice}
        graduationTaxVirtual={state.graduationTaxVirtual}
        buybackSpentVirtual={state.buybackSpentVirtual}
        remainingTaxVirtual={state.remainingTaxVirtual}
      />
    </div>
  )
}

