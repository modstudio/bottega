// concern: cleanup sweep claim reconciliation
/** Observes claimed resources and settles only rows whose absence passes every lifecycle guard. */

import type { Database } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
import {
  type GitRefObservation,
  observeGitRef,
  restoreBranch as restoreProtectedBranch,
} from '../git/git-environment.ts'
import { withCleanupLock, withWorktreeLease } from '../project/project-lock.ts'
import { runLeaseState } from '../run/run-lease.ts'
import type { GrokTrustObservation } from '../sandbox/grok-trust.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { decideAbsentClaim } from './cleanup-sweep-decisions.ts'

const RECONCILED_KINDS = [
  'branch',
  'retained_ref',
  'worktree',
  'sandbox_dir',
  'trust_entry',
] as const
type ReconciledKind = (typeof RECONCILED_KINDS)[number]

type ClaimedRow = {
  id: number
  root_run_id: number
  run_id: number
  project_id: number | null
  kind: ReconciledKind
  allocation_key: string
  project_name: string | null
  project_path: string | null
  run_repo: string | null
  run_cwd: string | null
  launch_cwd: string | null
  recorded_worktree: string | null
  worktree_path: string | null
}

export type ClaimReconciliationObservers = {
  path: (path: string) => { outcome: 'present' | 'absent' | 'failed'; detail?: string }
  ref: (repository: string, ref: string) => GitRefObservation
  commit: (repository: string, tip: string) => GitRefObservation
  restoreBranch: typeof restoreProtectedBranch
  trust: GrokTrustObservation
  leaseState: typeof runLeaseState
  pidAlive: typeof pidAlive
}

type ClaimSynchronizer = (
  row: Pick<ClaimedRow, 'id' | 'project_path' | 'worktree_path'>,
  reconcile: () => void,
) => void

type ReconciliationResult = { action: string; detail?: string }

function observePath(path: string): { outcome: 'present' | 'absent' | 'failed'; detail?: string } {
  try {
    lstatSync(path)
    return { outcome: 'present' }
  } catch (error) {
    const detail = String((error as Error)?.message ?? error)
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { outcome: 'absent' }
      : { outcome: 'failed', detail }
  }
}

const defaultObservers = (trust: GrokTrustObservation): ClaimReconciliationObservers => ({
  path: observePath,
  ref: observeGitRef,
  commit: (repository, tip) => observeGitRef(repository, `${tip}^{commit}`),
  restoreBranch: restoreProtectedBranch,
  trust,
  leaseState: runLeaseState,
  pidAlive,
})

function claimedRows(database: Database, projectName: string | undefined): ClaimedRow[] {
  return database
    .query(
      `SELECT claim.id,claim.root_run_id,claim.run_id,claim.project_id,claim.kind,claim.allocation_key,
              project.name project_name,project.path project_path,root.repo run_repo,
              root.cwd run_cwd,root.launch_cwd,root.worktree recorded_worktree,
              CASE WHEN claim.kind='worktree' THEN claim.allocation_key ELSE
                (SELECT tree.allocation_key FROM resource_claim tree
                 WHERE tree.root_run_id=claim.root_run_id AND tree.kind='worktree'
                 ORDER BY CASE WHEN tree.run_id=claim.run_id THEN 0 ELSE 1 END,tree.id DESC LIMIT 1)
              END worktree_path
       FROM resource_claim claim
       JOIN run root ON root.id=claim.root_run_id
       LEFT JOIN project ON project.id=claim.project_id
       WHERE claim.state='claimed'
         AND claim.kind IN ('branch','retained_ref','worktree','sandbox_dir','trust_entry')
         AND (? IS NULL OR project.name=?)
       ORDER BY claim.id`,
    )
    .all(projectName ?? null, projectName ?? null) as ClaimedRow[]
}

function unregisteredRepositoryPath(row: ClaimedRow): string | null {
  const marker = '/.claude/worktrees/'
  for (const path of [row.recorded_worktree, row.run_cwd]) {
    const index = path?.indexOf(marker) ?? -1
    if (path && index > 0) return path.slice(0, index)
  }
  if (row.run_repo?.startsWith('/')) return row.run_repo
  return row.launch_cwd
}

function owningRepository(
  row: ClaimedRow,
  observers: ClaimReconciliationObservers,
): {
  path: string | null
  state: 'known' | 'unknown-present' | 'unknown-absent'
} {
  if (row.project_path) return { path: row.project_path, state: 'known' }
  const path = unregisteredRepositoryPath(row)
  if (!path) return { path: null, state: 'unknown-present' }
  const observation = observers.path(path)
  if (observation.outcome === 'absent') return { path, state: 'unknown-absent' }
  if (observation.outcome === 'present') {
    return {
      path,
      state: row.kind === 'branch' || row.kind === 'retained_ref' ? 'known' : 'unknown-present',
    }
  }
  return { path: null, state: 'unknown-present' }
}

function claimedRow(database: Database, claimId: number): ClaimedRow | null {
  return claimedRows(database, undefined).find((row) => row.id === claimId) ?? null
}

const synchronizeClaim: ClaimSynchronizer = (row, reconcile) => {
  if (!row.project_path) return reconcile()
  const identity = { session: sessionId(), what: `reconcile absent claim ${row.id}` }
  const underCleanupLock = () => withCleanupLock(row.project_path!, identity, reconcile)
  if (!row.worktree_path) return underCleanupLock()
  return withWorktreeLease(row.project_path, row.worktree_path, identity, underCleanupLock)
}

function resourceObservation(
  row: ClaimedRow,
  repositoryPath: string | null,
  repositoryState: 'known' | 'unknown-present' | 'unknown-absent',
  observers: ClaimReconciliationObservers,
): { probe: 'present' | 'absent' | 'failed'; detail: string } {
  if (
    repositoryState === 'unknown-absent' &&
    (row.kind === 'branch' || row.kind === 'retained_ref')
  ) {
    return { probe: 'absent', detail: `observed absent repository ${repositoryPath}` }
  }
  if (row.kind === 'branch' || row.kind === 'retained_ref') {
    if (!repositoryPath) return { probe: 'failed', detail: 'owning repository unknown' }
    const observation = observers.ref(repositoryPath, row.allocation_key)
    return observation.outcome === 'failed'
      ? { probe: 'failed', detail: observation.detail }
      : {
          probe: observation.outcome,
          detail: `observed absent ref ${row.allocation_key} in ${repositoryPath}`,
        }
  }
  if (row.kind === 'trust_entry') {
    if (!observers.trust.succeeded) return { probe: 'failed', detail: observers.trust.detail }
    return observers.trust.headings.includes(row.allocation_key)
      ? { probe: 'present', detail: 'trust heading is present' }
      : { probe: 'absent', detail: `observed absent trust heading ${row.allocation_key}` }
  }
  const observation = observers.path(row.allocation_key)
  if (observation.outcome === 'failed')
    return { probe: 'failed', detail: observation.detail ?? 'path observation failed' }
  return observation.outcome === 'present'
    ? { probe: 'present', detail: 'path is present' }
    : { probe: 'absent', detail: `observed absent path ${row.allocation_key}` }
}

function conversationFacts(
  database: Database,
  row: ClaimedRow,
  observers: ClaimReconciliationObservers,
) {
  const turns = database
    .query(
      `SELECT id,status,pid,agent_pid,branch_kept,branch_kept_tip FROM run
       WHERE id=? OR parent_run_id=? ORDER BY id`,
    )
    .all(row.root_run_id, row.root_run_id) as {
    id: number
    status: string
    pid: number | null
    agent_pid: number | null
    branch_kept: string | null
    branch_kept_tip: string | null
  }[]
  const terminal = new Set(['ok', 'failed', 'stale', 'stopped'])
  const claimTurn = turns.find((turn) => turn.id === row.run_id)
  const branchKept = Boolean(
    row.kind === 'branch' &&
      claimTurn?.branch_kept &&
      `refs/heads/${claimTurn.branch_kept}` === row.allocation_key,
  )
  return {
    allTurnsTerminal: turns.every((turn) => terminal.has(turn.status)),
    liveLeaseOrPid: turns.some(
      (turn) =>
        observers.leaseState(turn.id) === 'held' ||
        Boolean(turn.pid && observers.pidAlive(turn.pid)) ||
        Boolean(turn.agent_pid && observers.pidAlive(turn.agent_pid)),
    ),
    branchKept,
    recordedTip: branchKept ? (claimTurn?.branch_kept_tip ?? null) : null,
  }
}

export function landingInFlight(database: Database, project: string, branch: string): boolean {
  return Boolean(
    database
      .query(
        `SELECT 1 FROM landing
         WHERE project=? AND branch=? AND status IN ('queued','running') LIMIT 1`,
      )
      .get(project, branch),
  )
}

function claimLandingInFlight(database: Database, row: ClaimedRow): boolean {
  if (row.kind !== 'branch' || !row.project_name) return false
  return landingInFlight(
    database,
    row.project_name,
    row.allocation_key.replace(/^refs\/heads\//, ''),
  )
}

function rulingFor(database: Database, row: ClaimedRow, observers: ClaimReconciliationObservers) {
  const repository = owningRepository(row, observers)
  const observation = resourceObservation(row, repository.path, repository.state, observers)
  const conversation = conversationFacts(database, row, observers)
  const recordedTipObservation =
    conversation.branchKept &&
    observation.probe === 'absent' &&
    conversation.recordedTip &&
    repository.path &&
    repository.state !== 'unknown-absent'
      ? observers.commit(repository.path, conversation.recordedTip)
      : { outcome: 'absent' as const }
  return {
    repository,
    observation,
    conversation,
    ruling: decideAbsentClaim({
      probe: observation.probe,
      owningRepository: repository.state,
      ...conversation,
      recordedTipProbe: recordedTipObservation.outcome,
      landingInFlight: claimLandingInFlight(database, row),
    }),
  }
}

export function reconcileAbsentClaims(input: {
  dryRun: boolean
  project?: string
  presentation: CleanupPresentation
  trust: GrokTrustObservation
  database?: Database
  observers?: Partial<ClaimReconciliationObservers>
  synchronize?: ClaimSynchronizer
}): void {
  const database = input.database ?? db()
  const observers: ClaimReconciliationObservers = {
    ...defaultObservers(input.trust),
    ...input.observers,
  }
  const synchronize = input.synchronize ?? synchronizeClaim
  for (const row of claimedRows(database, input.project)) {
    const initial = rulingFor(database, row, observers)
    const { ruling } = initial
    const label = `claim ${row.id} ${row.kind} ${row.allocation_key}`
    const branch = row.allocation_key.replace(/^refs\/heads\//, '')
    if (ruling.action === 'keep') {
      if (input.dryRun) input.presentation.log(`kept: ${label}: ${ruling.reason}`)
      continue
    }
    if (input.dryRun) {
      if (ruling.action === 'restore-retained') {
        input.presentation.log(`would restore ${branch} at ${initial.conversation.recordedTip}`)
      } else if (ruling.action === 'settle-retained') {
        input.presentation.log(`would settle retained ${label}`)
      } else if (ruling.action === 'release-lost-tip') {
        input.presentation.log(
          initial.conversation.recordedTip
            ? `would release, tip ${initial.conversation.recordedTip} is gone: ${label}`
            : `would release, no tip was recorded: ${label}`,
        )
      } else {
        input.presentation.log(`would settle absent ${label}`)
      }
      continue
    }
    const completed: { value: ReconciliationResult | null } = { value: null }
    synchronize(row, () => {
      const lockedRow = claimedRow(database, row.id)
      if (!lockedRow) return
      const locked = rulingFor(database, lockedRow, observers)
      if (locked.ruling.action === 'keep') {
        completed.value = { action: 'keep', detail: locked.ruling.reason }
        return
      }
      if (locked.ruling.action === 'restore-retained') {
        const repository = locked.repository.path
        const tip = locked.conversation.recordedTip
        if (!repository || !tip) return
        const restored = observers.restoreBranch(repository, branch, tip)
        if (!restored.ok) {
          completed.value = { action: 'restore-failed', detail: restored.error }
          return
        }
      }
      const retained =
        locked.ruling.action === 'settle-retained' || locked.ruling.action === 'restore-retained'
      const lost = locked.ruling.action === 'release-lost-tip'
      const tip = locked.conversation.recordedTip
      const settledDetail = retained
        ? tip
          ? `branch retained at ${tip}`
          : `branch ${branch} retained; no tip was recorded`
        : lost
          ? tip
            ? `branch ${branch} lost; tip ${tip} is gone`
            : `branch ${branch} lost; no tip was recorded`
          : locked.observation.detail
      let settled = false
      writeTransaction(() => {
        const result = database
          .query(
            `UPDATE resource_claim SET state=?,settled_at=?,settled_detail=?
             WHERE id=? AND state='claimed'`,
          )
          .run(retained ? 'retained' : 'absent', nowIso(), settledDetail, lockedRow.id)
        settled = result.changes === 1
      }, database)
      if (settled) completed.value = { action: locked.ruling.action, detail: tip ?? undefined }
    })
    const result = completed.value
    if (!result) continue
    if (result.action === 'keep') {
      input.presentation.log(`kept: ${label}: ${result.detail ?? 'lifecycle guard changed'}`)
    } else if (result.action === 'restore-failed') {
      input.presentation.log(`kept: ${label}: restore failed: ${result.detail}`)
    } else if (result.action === 'restore-retained') {
      input.presentation.log(`restored ${branch} at ${result.detail}`)
    } else if (result.action === 'settle-retained') {
      input.presentation.log(`settled retained ${label}`)
    } else if (result.action === 'release-lost-tip') {
      input.presentation.log(
        result.detail
          ? `released, tip ${result.detail} is gone: ${label}`
          : `released, no tip was recorded: ${label}`,
      )
    } else {
      input.presentation.log(`settled absent ${label}`)
    }
  }
}
