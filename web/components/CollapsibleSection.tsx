'use client'

import { useEffect, useState, type ReactNode } from 'react'

interface Props {
  title: string
  subtitle?: string
  defaultExpanded?: boolean
  storageKey?: string
  children: ReactNode
}

export function CollapsibleSection({
  title,
  subtitle,
  defaultExpanded = true,
  storageKey,
  children,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  useEffect(() => {
    if (!storageKey) return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw === 'true') setExpanded(true)
      if (raw === 'false') setExpanded(false)
    } catch {
      // Ignore storage errors (private mode, quota, etc.)
    }
  }, [storageKey])

  useEffect(() => {
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, expanded ? 'true' : 'false')
    } catch {
      // Ignore storage errors (private mode, quota, etc.)
    }
  }, [expanded, storageKey])

  return (
    <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 border-b border-[var(--card-border)] flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors"
      >
        <div>
          <div className="font-semibold">{title}</div>
          {subtitle ? <div className="text-xs text-[var(--muted)] mt-0.5">{subtitle}</div> : null}
        </div>
        <span className="text-xs text-[var(--muted)]">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>
      {expanded ? <div className="p-0">{children}</div> : null}
    </div>
  )
}
