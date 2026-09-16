// concern: hook-tree
/** Owns hook-tree identity and pure lifecycle decisions. Must not know databases, worktree execution, or the CLI. */

export const HOOK_TREE_JOB = 'hook-tree'
export const HOOK_TREE_AGENT = '(hook)'
export const HOOK_TREE_EVIDENCE_EXCLUSION = 'hook tree lifecycle row; not agent execution'
export const HOOK_TREE_NOTICE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type HookTreeIdentity = { job: string }

export function isHookTree(run: HookTreeIdentity): boolean {
  return run.job === HOOK_TREE_JOB
}

/** Hook trees are held indefinitely; bounded ordinary run holds remain unchanged. */
export function hookTreeHoldDecision<T>(
  run: HookTreeIdentity,
  ordinary: T,
): T | { held: true; until: null; reason: string } {
  return isHookTree(run)
    ? { held: true, until: null, reason: 'hook tree; remove with orch tree remove <path>' }
    : ordinary
}

/** Sweep never owns a person's hook tree. */
export function shouldSweepHookTree(run: HookTreeIdentity): boolean {
  return !isHookTree(run)
}

export type HookTreeNoticeInput = HookTreeIdentity & {
  id: number
  status: string
  path: string
  startedAt: string
}

/** A failed hook tree is immediate; a successful one becomes a notice after the named age. */
export function hookTreeNotice(run: HookTreeNoticeInput, clock: number) {
  if (!isHookTree(run)) return null
  if (run.status !== 'ok') {
    const startedAt = Date.parse(run.startedAt)
    return {
      kind: 'hook-tree-failed',
      subject: `run:${run.id}`,
      since: run.startedAt,
      ageMs: Number.isFinite(startedAt) ? Math.max(0, clock - startedAt) : null,
      detail: `hook tree ${run.path} has run status ${run.status}`,
      action: `orch tree remove ${run.path}`,
      severity: 'informational' as const,
    }
  }
  const startedAt = Date.parse(run.startedAt)
  if (!Number.isFinite(startedAt)) return null
  const ageMs = Math.max(0, clock - startedAt)
  if (ageMs <= HOOK_TREE_NOTICE_AFTER_MS) return null
  return {
    kind: 'hook-tree-old',
    subject: `run:${run.id}`,
    since: run.startedAt,
    ageMs,
    detail: `hook tree ${run.path} remains provisioned`,
    action: `orch tree remove ${run.path}`,
    severity: 'informational' as const,
  }
}

/** The row is a lifecycle owner, never evidence or a statistic about agent work. */
export function hookTreeEvidenceDecision(): {
  evidenceExcluded: string
} {
  return { evidenceExcluded: HOOK_TREE_EVIDENCE_EXCLUSION }
}

export function nonHookTreeStatsSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('run alias must be a SQL identifier')
  return `${alias}.job <> '${HOOK_TREE_JOB}'`
}
