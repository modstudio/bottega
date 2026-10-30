// concern: reader-tree monitor conditions
/** Detects escaped shared readers and duplicate confined clones from recorded run paths. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { SESSION_LIVE_MS } from '../database/db.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { isReadOnlyRepositoryJob, JOBS } from '../jobs/jobs.ts'
import { withWorktreeLease } from '../project/project-lock.ts'
import { isSharedReaderWorktreeClaim } from '../resources/resource-claims.ts'
import { recordedRunLivenessFacts, runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import { recordedOwnerProcess } from '../run/run-owner-session-liveness.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import type { MonitorCondition } from './monitor-types.ts'

export type ReaderTreeObservation = {
  runId: string
  project: string
  worktree: string
  commit: string | null
  startedAt: string
  live: boolean
  confined: boolean
  readOnly: boolean
  dirty: boolean | null
  dirtyDetail: string | null
  shared: boolean
}

export function readerTreeHealthConditions(
  observations: readonly ReaderTreeObservation[],
): MonitorCondition[] {
  const conditions: MonitorCondition[] = []
  const byPath = Map.groupBy(observations, (row) => row.worktree)
  for (const [path, rows] of byPath) {
    if (!rows.some((row) => row.shared)) continue
    const dirty = rows.find((row) => row.dirty === true)
    if (!dirty) continue
    conditions.push({
      kind: 'shared-reader-tree-dirty',
      subject: path,
      since: rows.map((row) => row.startedAt).sort()[0] ?? null,
      ageMs: null,
      detail:
        `${dirty.dirtyDetail ?? 'shared reader tree differs from its base'}; ` +
        `sharers ${rows.map((row) => row.runId).join(', ')}`,
      action: `archive the escaped paths through ${PLATFORM_SLUG} run close-out, then inspect the reader clone archive pointer`,
    })
  }

  const liveReaders = observations.filter(
    (row) => row.live && row.confined && row.readOnly && row.commit !== null,
  )
  const byRevision = Map.groupBy(liveReaders, (row) => `${row.project}\0${row.commit}`)
  for (const rows of byRevision.values()) {
    const trees = [...new Set(rows.map((row) => row.worktree))]
    if (trees.length < 2) continue
    conditions.push({
      kind: 'duplicate-reader-clone',
      subject: `${rows[0]!.project}:${rows[0]!.commit}`,
      since: rows.map((row) => row.startedAt).sort()[0] ?? null,
      ageMs: null,
      detail: `live confined readers use ${trees.length} trees: ${trees.join(', ')}`,
      action: `allow the runs to close, then repeat the review round so its lenses attach to one shared reader tree`,
    })
  }
  return conditions
}

export function observeReaderTreeConditions(database: Database): MonitorCondition[] {
  const readOnlyJobs = Object.values(JOBS)
    .filter((candidate) => isReadOnlyRepositoryJob(candidate.name))
    .map((candidate) => candidate.name)
  const rows = database
    .query(
      `SELECT r.record_id, r.job, r.worktree, r.started_at, r.status, r.sandbox, r.pid,
              r.executor, r.session_id, r.harness_wall_bound_ms,
              (SELECT last_seen FROM session_seen WHERE session_id=r.session_id) session_last_seen,
              COALESCE(
                (SELECT json_extract(rc.identity, '$.head') FROM resource_claim rc
                  WHERE rc.kind='worktree' AND rc.allocation_key=r.worktree
                  ORDER BY rc.claimed_at LIMIT 1),
                r.carry_base_commit, r.base_commit
              ) reviewed_commit,
              COALESCE(p.name, r.repo, 'unregistered') project, p.path repo_root
       FROM run r LEFT JOIN project p ON p.record_id=r.project_record_id
       WHERE r.worktree IS NOT NULL AND r.job IN (${readOnlyJobs.map(() => '?').join(',')})`,
    )
    .all(...readOnlyJobs) as {
    record_id: string
    job: string
    worktree: string
    started_at: string
    status: string
    sandbox: string | null
    pid: number | null
    executor: 'external' | 'harness'
    session_id: string | null
    harness_wall_bound_ms: number | null
    session_last_seen: string | null
    reviewed_commit: string | null
    project: string
    repo_root: string | null
  }[]
  const now = Date.now()
  const observations = rows.map((row): ReaderTreeObservation => {
    return {
      runId: row.record_id,
      project: row.project,
      worktree: realpathOrSpelled(row.worktree),
      commit: row.reviewed_commit,
      startedAt: row.started_at,
      live: runAlive({
        status: row.status,
        lease: runLeaseState(row.record_id),
        pidAlive: pidAlive(row.pid),
        ...recordedRunLivenessFacts(
          row,
          now,
          SESSION_LIVE_MS,
          recordedOwnerProcess(database, row.session_id, now),
        ),
      }),
      confined: row.sandbox === 'srt',
      readOnly: true,
      dirty: null,
      dirtyDetail: null,
      shared: isSharedReaderWorktreeClaim(database, row.worktree),
    }
  })
  const rowByPath = Map.groupBy(rows, (row) => realpathOrSpelled(row.worktree))
  for (const [path, pathObservations] of Map.groupBy(observations, (row) => row.worktree)) {
    if (!pathObservations.some((row) => row.shared) || pathObservations.some((row) => row.live))
      continue
    const repoRoot = rowByPath.get(path)?.find((row) => row.repo_root)?.repo_root
    if (!repoRoot || !existsSync(path)) continue
    const dirty = withWorktreeLease(
      repoRoot,
      path,
      { session: null, what: 'observe released shared reader tree' },
      () => worktreeDirty(path),
    )
    for (const observation of pathObservations) {
      observation.dirty = dirty.dirty
      observation.dirtyDetail = dirty.detail
    }
  }
  return readerTreeHealthConditions(observations)
}
