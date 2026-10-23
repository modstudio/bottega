/** Plain-value classification and presentation for a SQLite write-lock refusal. */

export type DatabaseLockRefusalFacts = {
  store: string
  holder: { pid: number; command: string | null } | { unavailable: string }
}

export function isDatabaseLocked(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate?.code === 'SQLITE_BUSY' ||
    candidate?.code === 'SQLITE_LOCKED' ||
    /database (?:table )?is locked/i.test(String(candidate?.message))
  )
}

export function formatDatabaseLockRefusal(facts: DatabaseLockRefusalFacts): string {
  const holder =
    'pid' in facts.holder
      ? `pid ${facts.holder.pid}; command ${facts.holder.command ?? 'unavailable'}`
      : `unknown (${facts.holder.unavailable})`
  return (
    `database write refused: database is locked\n` +
    `store: ${facts.store}\n` +
    `holder: ${holder}\n` +
    'cleared by: wait for the holder to finish, then retry the command'
  )
}
