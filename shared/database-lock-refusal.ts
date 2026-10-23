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

/**
 * Name the holder by its executable and script only: its other arguments belong to
 * another process and may carry a secret, and this refusal reaches recorded run output.
 */
function holderSummary(command: string): string {
  const [executable = '', script] = command.trim().split(/\s+/)
  const base = (token: string) => token.split('/').pop() ?? token
  return script?.includes('/') ? `${base(executable)} ${base(script)}` : base(executable)
}

export function formatDatabaseLockRefusal(facts: DatabaseLockRefusalFacts): string {
  const holder =
    'pid' in facts.holder
      ? `pid ${facts.holder.pid}; command ${facts.holder.command ? holderSummary(facts.holder.command) : 'unavailable'}`
      : `unknown (${facts.holder.unavailable})`
  return (
    `database write refused: database is locked\n` +
    `store: ${facts.store}\n` +
    `holder: ${holder}\n` +
    'cleared by: wait for the holder to finish, then retry the command'
  )
}
