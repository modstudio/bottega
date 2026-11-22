// concern: canon-mirror-revisions
/** Reads the revision timestamps needed by the canon mirror's revert guard. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { HydrationPlan } from './canon-hydrate.ts'
import { canonMirrorRevertRefusal } from './canon-mirror-revert-guard.ts'

type CanonRevisionHistory = {
  latestAt: string | null
  removalAt: string | null
  newestCanonAt: string | null
}

function canonRevisionHistory(
  project: string,
  path: string,
  subject: string | null | undefined,
  database: Database = db(),
): CanonRevisionHistory {
  const latest = database
    .query<{ at: string; op: string; status: string }, [string, string]>(
      `SELECT at,op,status FROM doc_revision
       WHERE scope='canon' AND owner IS NULL AND slug=? AND (subject=? OR subject IS NULL)
       ORDER BY at DESC,number DESC LIMIT 1`,
    )
    .get(path, project)
  const row =
    subject === undefined
      ? null
      : database
          .query<{ at: string }, [string, string | null]>(
            `SELECT at FROM doc_revision
             WHERE scope='canon' AND owner IS NULL AND slug=? AND subject IS ?
             ORDER BY number DESC LIMIT 1`,
          )
          .get(path, subject)
  const newest = database
    .query<{ at: string }, [string]>(
      `SELECT at FROM doc_revision
       WHERE scope='canon' AND owner IS NULL AND (subject=? OR subject IS NULL)
       ORDER BY at DESC,number DESC LIMIT 1`,
    )
    .get(project)
  return {
    latestAt: row?.at ?? (subject === undefined ? (latest?.at ?? null) : null),
    removalAt: latest && (latest.op === 'delete' || latest.status !== 'current') ? latest.at : null,
    newestCanonAt: newest?.at ?? null,
  }
}

export function assertHydrationDoesNotRevertBranchCanon(input: {
  project: string
  base: string
  plan: HydrationPlan
  rows: Array<{ slug: string; subject: string | null }>
  lastPathCommit(path: string): { sha: string; at: string } | null
  database?: Database
}): void {
  for (const write of input.plan.writes) {
    const row = input.rows.find((candidate) => candidate.slug === write.path)
    if (!row) continue // generated output has no independently adoptable store slug
    const history = canonRevisionHistory(input.project, write.path, row.subject, input.database)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path: write.path,
      operation: 'write',
      commit: input.lastPathCommit(write.path),
      rowRevisionAt: history.latestAt,
      removalAt: null,
      newestCanonAt: history.newestCanonAt,
    })
    if (refusal) throw new Error(refusal)
  }
  for (const path of input.plan.deletes) {
    const history = canonRevisionHistory(input.project, path, undefined, input.database)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path,
      operation: 'delete',
      commit: input.lastPathCommit(path),
      rowRevisionAt: history.latestAt,
      removalAt: history.removalAt,
      newestCanonAt: history.newestCanonAt,
    })
    if (refusal) throw new Error(refusal)
  }
}
