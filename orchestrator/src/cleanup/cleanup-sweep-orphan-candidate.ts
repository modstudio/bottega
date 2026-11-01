// concern: cleanup sweep filesystem orphan candidate
import { basename } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { recordedRunLivenessFacts, runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import { recordedOwnerProcess } from '../run/run-owner-session-liveness.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { readerCloneUniqueCommitCount } from '../worktree/reader-clone-commit-observer.ts'
import {
  isOrchWorktree,
  orphanSafety,
  readerCloneCreator,
  readWorktreeMarker,
  type WorktreeMarkerRead,
  worktreeDirty,
  worktreeNameRunId,
} from '../worktree/worktree-attribution.ts'
import {
  decideConversationProjectOwnership,
  decideFilesystemOrphanCandidate,
} from './cleanup-sweep-decisions.ts'

type NamedRun = { record_id: string; status: string; alive: boolean }
export type NamedRunLookup =
  | { outcome: 'absent' }
  | { outcome: 'owned'; run: NamedRun }
  | { outcome: 'unknown'; runId: string; reason: string }

function namedRun(
  name: string,
  project: Project,
  fallbackRunId: string | null = null,
): NamedRunLookup {
  const runRecordId = worktreeNameRunId(name) ?? fallbackRunId
  if (runRecordId === null) return { outcome: 'absent' }
  const member = db()
    .query(
      `SELECT member.record_id, member.parent_run_record_id,
              member.project_record_id, root.project_record_id root_project_record_id
       FROM run member
       JOIN run root ON root.record_id=COALESCE(member.parent_run_record_id,member.record_id)
       WHERE member.record_id=?`,
    )
    .get(runRecordId) as {
    record_id: string
    parent_run_record_id: string | null
    project_record_id: string | null
    root_project_record_id: string | null
  } | null
  if (!member) return { outcome: 'absent' }

  const rootId = member.parent_run_record_id ?? member.record_id
  const members = db()
    .query(
      `SELECT record_id,project_record_id
       FROM run
       WHERE record_id=? OR parent_run_record_id=?
       ORDER BY number`,
    )
    .all(rootId, rootId) as { record_id: string; project_record_id: string | null }[]
  const ownership = decideConversationProjectOwnership({
    root: { record_id: rootId, projectRecordId: member.root_project_record_id },
    members: members.map(({ record_id, project_record_id }) => ({
      record_id,
      projectRecordId: project_record_id,
    })),
    expectedProjectRecordId: project.recordId,
  })
  if (ownership.outcome === 'unknown') {
    return { outcome: 'unknown', runId: member.record_id, reason: ownership.reason }
  }
  const latest = db()
    .query(
      `SELECT record_id,status,pid,executor,session_id,started_at,job,harness_wall_bound_ms,
              (SELECT last_seen FROM session_seen WHERE session_id=run.session_id) session_last_seen FROM run
      WHERE record_id=? OR parent_run_record_id=?
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as {
    record_id: string
    status: string
    pid: number | null
    executor: 'external' | 'harness'
    session_id: string | null
    started_at: string
    job: string
    session_last_seen: string | null
    harness_wall_bound_ms: number | null
  }
  return {
    outcome: 'owned',
    run: {
      record_id: member.record_id,
      status: latest.status,
      alive: runAlive({
        status: latest.status,
        lease: runLeaseState(latest.record_id),
        pidAlive: Boolean(latest.pid && pidAlive(latest.pid)),
        ...recordedRunLivenessFacts(
          latest,
          Date.now(),
          SESSION_LIVE_MS,
          recordedOwnerProcess(db(), latest.session_id),
        ),
      }),
    },
  }
}

export function observeNamedRunForSweep(
  path: string,
  project: Project,
  fallbackRunId: string | null = null,
): NamedRunLookup {
  const lookup = namedRun(path, project, fallbackRunId)
  return lookup
}

export type OrphanCandidateDecision =
  | { action: 'keep'; line: string; reason: string; failed: boolean; held: boolean }
  | { action: 'dry'; detail: string; failed: boolean }
  | {
      action: 'reclaim'
      runId: string
      safe: ReturnType<typeof orphanSafety>
      failed: boolean
    }

type OrphanOwner = { record_id: string; status: string }

function orphanCandidateIds(
  path: string,
  marker: WorktreeMarkerRead,
): { nameRunId: string | null; runRecordId: string | null } {
  if (marker.state === 'present') return { nameRunId: null, runRecordId: marker.runRecordId }
  if (marker.state === 'unreadable') return { nameRunId: null, runRecordId: null }
  const creator = readerCloneCreator(basename(path))
  const nameRunId = creator?.kind === 'run' ? creator.runId : null
  return { nameRunId, runRecordId: nameRunId }
}

function orphanOwner(runRecordId: string | null): OrphanOwner | null {
  return (
    db()
      .query<OrphanOwner, [string]>('SELECT record_id,status FROM run WHERE record_id=?')
      .get(runRecordId ?? '') ?? null
  )
}

function orphanRunState(owner: OrphanOwner | null): 'absent' | 'terminal' | 'live' {
  if (!owner) return 'absent'
  return TERMINAL_RUN_STATUS_SET.has(owner.status) ? 'terminal' : 'live'
}

function unmarkedReaderWorkFacts(
  path: string,
  projectPath: string,
  marker: WorktreeMarkerRead,
  nameRunId: string | null,
  owner: OrphanOwner | null,
  readerClone: boolean,
): {
  dirty: ReturnType<typeof worktreeDirty> | null
  uniqueCommitCount: number | null
} {
  if (marker.state !== 'absent' || !nameRunId || !owner || !readerClone) {
    return { dirty: null, uniqueCommitCount: null }
  }
  return {
    dirty: worktreeDirty(path),
    uniqueCommitCount: readerCloneUniqueCommitCount(path, projectPath),
  }
}

function orphanCandidateHeld(input: {
  namedAlive: boolean
  marker: WorktreeMarkerRead
  nameRunId: string | null
  path: string
  removable: boolean
  owner: OrphanOwner | null
}): boolean {
  if (!input.owner) return false
  if (input.namedAlive) return true
  if (input.marker.state === 'absent' && input.nameRunId !== null) return true
  return isOrchWorktree(input.path) && !input.removable
}

export function orphanCandidateDecision(
  path: string,
  project: Project,
  dry: boolean,
): OrphanCandidateDecision {
  const marker = readWorktreeMarker(path)
  const { nameRunId, runRecordId } = orphanCandidateIds(path, marker)
  const owner = orphanOwner(runRecordId)
  const named = owner
    ? observeNamedRunForSweep(path, project, nameRunId)
    : { outcome: 'absent' as const }
  const trunk =
    typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
      ? project.settings.trunk
      : 'HEAD'
  const safe = orphanSafety(path, project.path, trunk)
  const work = unmarkedReaderWorkFacts(
    path,
    project.path,
    marker,
    nameRunId,
    owner,
    safe.unmarkedBorrowedReader,
  )
  const namedAlive = named.outcome === 'owned' && named.run.alive
  const ruling = decideFilesystemOrphanCandidate({
    marker: marker.state,
    markerRunId: marker.state === 'present' ? marker.runRecordId : null,
    nameRunId,
    run: orphanRunState(owner),
    ownership: named.outcome === 'unknown' ? 'unknown' : 'owned',
    orchOwned: isOrchWorktree(path),
    readerClone: safe.unmarkedBorrowedReader,
    alive: namedAlive,
    removable: safe.removable,
    removalDetail: safe.detail,
    uniqueCommitCount: work.uniqueCommitCount,
    dirty: work.dirty?.dirty ?? false,
    dirtyDetail: work.dirty?.detail ?? 'all work is committed',
    dry,
  })
  if (ruling.action === 'keep') {
    return {
      action: 'keep',
      line: ruling.keepLine,
      reason: ruling.keepReason,
      failed: false,
      held: orphanCandidateHeld({
        namedAlive,
        marker,
        nameRunId,
        path,
        removable: safe.removable,
        owner,
      }),
    }
  }
  if (ruling.action === 'dry-would-reclaim') {
    return { action: 'dry', detail: safe.detail, failed: false }
  }
  if (!owner) throw new Error(`orphan reclaim ruling lacked owner for ${path}`)
  return { action: 'reclaim', runId: owner.record_id, safe, failed: false }
}
