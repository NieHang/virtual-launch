'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { api, type Project } from '@/lib/api'

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tokenAddress, setTokenAddress] = useState('')
  const [projectName, setProjectName] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    api
      .getProjects()
      .then(setProjects)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const addProject = async (e: FormEvent) => {
    e.preventDefault()
    const addr = tokenAddress.trim()
    const name = projectName.trim()
    if (!addr) {
      setAddError('tokenAddress is required')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const created = await api.addProject(addr, name || undefined)
      setProjects((prev) => {
        const exists = prev.some((p) => p.id === created.id)
        if (exists) return prev
        return [
          {
            id: created.id,
            name: created.name,
            tokenAddress: created.tokenAddress,
            phase: 'INTERNAL',
            createdAt: Math.floor(Date.now() / 1000),
          },
          ...prev,
        ]
      })
      setTokenAddress('')
      setProjectName('')
    } catch (err: any) {
      setAddError(err?.message || 'Failed to add project')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Projects</h1>
          <p className="text-[var(--muted)] mt-1">
            Tracked Virtuals Protocol tokens on Base
          </p>
        </div>
      </div>

      <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-4 mb-6">
        <form onSubmit={addProject} className="flex flex-col md:flex-row gap-3 md:items-end">
          <div className="flex-1">
            <label className="block text-xs text-[var(--muted)] mb-1">
              Token Contract Address
            </label>
            <input
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="0x..."
              className="w-full bg-black/30 border border-[var(--card-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>
          <div className="w-full md:w-56">
            <label className="block text-xs text-[var(--muted)] mb-1">
              Name (optional)
            </label>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Custom project name"
              className="w-full bg-black/30 border border-[var(--card-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
          </div>
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-md text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {adding ? 'Adding...' : 'Add Project'}
          </button>
        </form>
        {addError && (
          <div className="mt-3 text-sm text-red-400">
            {addError}
          </div>
        )}
      </div>

      {loading && (
        <div className="text-center py-20 text-[var(--muted)]">
          Loading projects...
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-400">
          {error}
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="text-center py-20">
          <p className="text-[var(--muted)] text-lg mb-4">
            No projects tracked yet
          </p>
          <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-6 max-w-md mx-auto text-left">
            <p className="text-sm text-[var(--muted)] mb-2">
              Add a project via CLI:
            </p>
            <code className="block bg-black/40 rounded p-3 text-sm text-green-400">
              npm run add-project 0xYOUR_TOKEN_ADDRESS
            </code>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <Link
            key={project.id}
            href={`/projects/${project.id}`}
            className="block bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-5 hover:border-[var(--accent)] transition-colors"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold truncate">{project.name}</h2>
              <span
                className={`text-xs px-2 py-1 rounded-full ${
                  project.phase === 'EXTERNAL'
                    ? 'bg-green-900/30 text-green-400'
                    : 'bg-yellow-900/30 text-yellow-400'
                }`}
              >
                {project.phase === 'EXTERNAL' ? 'Graduated' : 'Internal'}
              </span>
            </div>
            <p className="text-xs text-[var(--muted)] font-mono truncate">
              {project.tokenAddress}
            </p>
            <p className="text-xs text-[var(--muted)] mt-2">
              Added {new Date(project.createdAt * 1000).toLocaleDateString()}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}

