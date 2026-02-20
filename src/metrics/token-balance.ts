import { db, schema } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import type { ParsedTransfer } from '../types.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Update token balances from raw Transfer events.
 * Processes ALL token transfers (not just trades) to maintain accurate per-address balances.
 *
 * For each Transfer(from, to, value):
 *   - Decrease `from` balance by `value` (skip if from = 0x0, that's a mint)
 *   - Increase `to` balance by `value` (skip if to = 0x0, that's a burn)
 */
export function updateTokenBalances(
  projectId: string,
  tokenTransfers: ParsedTransfer[],
): void {
  if (tokenTransfers.length === 0) return

  // Batch updates in a local map first, then flush to DB
  const deltas = new Map<string, bigint>()

  for (const transfer of tokenTransfers) {
    const from = transfer.from.toLowerCase()
    const to = transfer.to.toLowerCase()
    const value = transfer.value

    if (value === 0n) continue

    // Decrease sender balance (skip mints from 0x0)
    if (from !== ZERO_ADDRESS) {
      deltas.set(from, (deltas.get(from) || 0n) - value)
    }

    // Increase receiver balance (skip burns to 0x0)
    if (to !== ZERO_ADDRESS) {
      deltas.set(to, (deltas.get(to) || 0n) + value)
    }
  }

  // Flush deltas to database
  const maxBlock = Math.max(...tokenTransfers.map((t) => t.blockNumber))

  for (const [address, delta] of deltas) {
    if (delta === 0n) continue

    const existing = db
      .select()
      .from(schema.tokenBalances)
      .where(
        and(
          eq(schema.tokenBalances.projectId, projectId),
          eq(schema.tokenBalances.address, address),
        ),
      )
      .get()

    if (existing) {
      const currentBalance = BigInt(existing.balance)
      const newBalance = currentBalance + delta
      // Clamp to 0 in case of rounding/ordering issues
      const finalBalance = newBalance < 0n ? 0n : newBalance

      db.update(schema.tokenBalances)
        .set({
          balance: finalBalance.toString(),
          lastUpdatedBlock: maxBlock,
        })
        .where(
          and(
            eq(schema.tokenBalances.projectId, projectId),
            eq(schema.tokenBalances.address, address),
          ),
        )
        .run()
    } else {
      // New address - delta should be positive (receiving tokens)
      const finalBalance = delta < 0n ? 0n : delta

      db.insert(schema.tokenBalances)
        .values({
          projectId,
          address,
          balance: finalBalance.toString(),
          lastUpdatedBlock: maxBlock,
        })
        .onConflictDoNothing()
        .run()
    }
  }
}
