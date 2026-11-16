/** Plain-value classification and presentation for a SQLite write-lock refusal. */

import type { WalWriteLockSampleResult } from './store-write-lock.ts'

export type DatabaseLockRefusalFacts = {
  store: string
  holder: { pid: number; command: string | null } | { unavailable: string }
}

/** The outcome of one WAL write-lock inspection: the sample it returned, or the error that ended it. */
export type LockHolderInspection =
  | { failed: unknown }
  | { sampled: WalWriteLockSampleResult; command: string | null }

export function sqliteErrorIdentity(error: unknown): { code: string | null; errno: number | null } {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return { code: null, errno: null }
  }
  const candidate = error as { code?: unknown; errno?: unknown }
  const code =
    Object.hasOwn(error, 'code') && typeof candidate.code === 'string' ? candidate.code : null
  const errno =
    Object.hasOwn(error, 'errno') && Number.isInteger(candidate.errno)
      ? (candidate.errno as number)
      : null
  return { code, errno }
}

export function isDatabaseLocked(error: unknown): boolean {
  const { code, errno } = sqliteErrorIdentity(error)
  if (
    errno !== null &&
    (code === null || code.startsWith('SQLITE_')) &&
    [5, 6].includes(errno & 0xff)
  )
    return true
  if (
    code === 'SQLITE_BUSY' ||
    code?.startsWith('SQLITE_BUSY_') ||
    code === 'SQLITE_LOCKED' ||
    code?.startsWith('SQLITE_LOCKED_')
  ) {
    return true
  }
  if (code?.startsWith('SQLITE_') || (code === null && errno !== null)) return false
  return /database (?:table )?is locked/i.test(
    String((error as { message?: unknown } | null)?.message),
  )
}

/**
 * One owner for turning a WAL write-lock inspection into the refusal's holder. The caller runs
 * the probe under its own guard and resolves the holder's command; this maps only, so hub and
 * orchestrator name the same holder and report the same three unavailable reasons.
 */
export function databaseLockHolder(
  inspection: LockHolderInspection,
): DatabaseLockRefusalFacts['holder'] {
  if ('failed' in inspection) {
    const detail =
      inspection.failed instanceof Error ? inspection.failed.message : String(inspection.failed)
    return { unavailable: `lock-holder inspection failed: ${detail}` }
  }
  const { sampled } = inspection
  if (!sampled.supported) return { unavailable: sampled.reason }
  if (sampled.holderPid === null) {
    return { unavailable: 'the lock was released before its holder could be inspected' }
  }
  return { pid: sampled.holderPid, command: inspection.command }
}

/**
 * Name the holder by its executable and script only: its other arguments belong to
 * another process and may carry a secret, and this refusal reaches recorded run output.
 */
export function databaseLockHolderCommandSummary(command: string): string {
  const [executable = '', ...tokens] = command.trim().split(/\s+/)
  const script = tokens.find((token) => !token.startsWith('-'))
  const base = (token: string) => token.split('/').pop() ?? token
  return script?.includes('/') ? `${base(executable)} ${base(script)}` : base(executable)
}

export function formatDatabaseLockRefusal(facts: DatabaseLockRefusalFacts): string {
  const holder =
    'pid' in facts.holder
      ? `pid ${facts.holder.pid}; command ${facts.holder.command ? databaseLockHolderCommandSummary(facts.holder.command) : 'unavailable'}`
      : `unknown (${facts.holder.unavailable})`
  return (
    `database write refused: database is locked\n` +
    `store: ${facts.store}\n` +
    `holder: ${holder}\n` +
    'cleared by: wait for the holder to finish, then retry the command'
  )
}
