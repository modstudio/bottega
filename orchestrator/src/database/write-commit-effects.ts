// concern: write-commit-effects
/** Owns best-effort effects that wait for the write transaction which registered them. */
import type { Database } from 'bun:sqlite'

type AfterWriteCommitEffect = () => void
type QueuedEffect = { effect: AfterWriteCommitEffect; key?: string }
const effectsByConnection = new WeakMap<Database, QueuedEffect[]>()

/** Run an effect after the owned write transaction commits, or now when none is owned here. */
export function afterWriteCommit(
  database: Database,
  effect: AfterWriteCommitEffect,
  key?: string,
): void {
  const queued = effectsByConnection.get(database)
  if (queued) {
    if (key !== undefined && queued.some((entry) => entry.key === key)) return
    queued.push({ effect, key })
    return
  }
  try {
    effect()
  } catch {
    // Effects outside an owned transaction are best-effort too.
  }
}

/** Begin collecting one connection's effects; false means an outer owner already collects them. */
export function beginWriteCommitEffects(database: Database): boolean {
  if (effectsByConnection.has(database)) return false
  effectsByConnection.set(database, [])
  return true
}

/** Run and forget the effects queued by a committed outer transaction. */
export function flushWriteCommitEffects(database: Database): void {
  const effects = effectsByConnection.get(database) ?? []
  effectsByConnection.delete(database)
  for (const { effect } of effects) {
    try {
      effect()
    } catch {
      // A failed effect cannot undo or report failure for an already committed write.
    }
  }
}

/** Forget effects queued by a transaction that did not commit. */
export function discardWriteCommitEffects(database: Database): void {
  effectsByConnection.delete(database)
}
