/** Plain-value classification and presentation for a SQLite write-lock refusal. */

export type DatabaseLockRefusalFacts = {
  store: string
  holder: { pid: number; command: string | null } | null
}

export function isDatabaseLocked(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate?.code === 'SQLITE_BUSY' || /database is locked/i.test(String(candidate?.message))
}

export function formatDatabaseLockRefusal(facts: DatabaseLockRefusalFacts): string {
  const holder = facts.holder
    ? `pid ${facts.holder.pid}; command ${facts.holder.command ?? 'unavailable'}`
    : 'unknown (the lock was released before its holder could be inspected)'
  return (
    `database write refused: database is locked\n` +
    `store: ${facts.store}\n` +
    `holder: ${holder}\n` +
    'cleared by: wait for the holder to finish, then retry the command'
  )
}
