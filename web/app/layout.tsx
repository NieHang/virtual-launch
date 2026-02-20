import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Virtual Launch Analytics',
  description: 'Real-time analytics for Virtuals Protocol tokens on Base',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <nav className="border-b border-[var(--card-border)] px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <Link href="/" className="text-xl font-bold text-[var(--accent)]">
              Virtual Launch
            </Link>
            <div className="flex items-center gap-4">
              <Link href="/efdv" className="text-sm text-[var(--accent)] hover:underline">
                EFDV Calculator
              </Link>
              <span className="text-sm text-[var(--muted)]">Base Chain Analytics</span>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  )
}

