// concern: reader-tree monitor conditions
/** Detects escaped shared readers and duplicate confined clones from recorded run paths. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { gitResult } from '../git/git-environment.ts'
import { isReadOnlyRepositoryJob } from '../jobs/jobs.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import type { MonitorCondition } from './monitor-types.ts'

export type ReaderTreeObservation = {
  runId: string
  runNumber: number
  project: string
  worktree: string
  commit: string | null
  startedAt: string
  live: boolean
  confined: boolean
  readOnly: boolean
  dirty: boolean | null
  dirtyDetail: string | null
}

export function readerTreeHealthConditions(
  observations: readonly ReaderTreeObservation[],
): MonitorCondition[] {
  const conditions: MonitorCondition[] = []
  const byPath = Map.groupBy(observations, (row) => row.worktree)
  for (const [path, rows] of byPath) {
    if (new Set(rows.map((row) => row.runId)).size < 2) continue
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
  const rows = database
    .query(
      `SELECT r.record_id, r.number, r.job, r.worktree, r.started_at, r.status, r.sandbox,
              COALESCE(p.name, r.repo, 'unregistered') project
       FROM run r LEFT JOIN project p ON p.record_id=r.project_record_id
       WHERE r.worktree IS NOT NULL`,
    )
    .all() as {
    record_id: string
    number: number
    job: string
    worktree: string
    started_at: string
    status: string
    sandbox: string | null
    project: string
  }[]
  const observations = rows.map((row): ReaderTreeObservation => {
    const present = existsSync(row.worktree)
    const head = present ? gitResult(['rev-parse', 'HEAD'], row.worktree) : null
    const dirty = present ? worktreeDirty(row.worktree) : null
    return {
      runId: row.record_id,
      runNumber: row.number,
      project: row.project,
      worktree: realpathOrSpelled(row.worktree),
      commit: head?.ok ? head.stdout.trim() : null,
      startedAt: row.started_at,
      live: row.status === 'running' || row.status === 'asking',
      confined: row.sandbox === 'srt',
      readOnly: isReadOnlyRepositoryJob(row.job),
      dirty: dirty?.dirty ?? null,
      dirtyDetail: dirty?.detail ?? null,
    }
  })
  return readerTreeHealthConditions(observations)
}
