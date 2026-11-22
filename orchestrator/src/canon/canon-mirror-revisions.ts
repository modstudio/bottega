// concern: canon-mirror-revisions
/** Reads the revision timestamps needed by the canon mirror's revert guard. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { type HydrationPlan, isGeneratedCanonOutputPath } from './canon-hydrate.ts'
import { canonMirrorRevertRefusal } from './canon-mirror-revert-guard.ts'

type CanonRevisionRow = {
  record_id: string
  op: string
  reason: string
  at: string
  status: string
}

/** Project canon wins over shared canon; revision number decides within that subject. */
function selectCanonRevisionRow(
  project: string,
  path: string,
  database: Database = db(),
): CanonRevisionRow | null {
  return database
    .query<CanonRevisionRow, [string, string, string]>(
      `SELECT record_id,op,reason,at,status FROM doc_revision
       WHERE scope='canon' AND owner IS NULL AND slug=? AND (subject=? OR subject IS NULL)
       ORDER BY CASE WHEN subject=? THEN 0 ELSE 1 END,number DESC LIMIT 1`,
    )
    .get(path, project, project)
}

function newestCanonRevisionAt(project: string, database: Database): string | null {
  const newest = database
    .query<{ at: string }, [string]>(
      `SELECT at FROM doc_revision
       WHERE scope='canon' AND owner IS NULL AND (subject=? OR subject IS NULL)
       ORDER BY at DESC,number DESC LIMIT 1`,
    )
    .get(project)
  return newest?.at ?? null
}

export type MirrorRevision = { path: string; revision: string; op: string; reason: string }

export function canonMirrorCommitBody(rows: MirrorRevision[]): string {
  return rows
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      (row) =>
        `${row.path}\nRevision: ${row.revision}\nOperation: ${row.op}\nReason: ${row.reason}`,
    )
    .join('\n\n')
}

export function revisionRows(
  project: string,
  paths: string[],
  database: Database = db(),
): MirrorRevision[] {
  return paths.map((path) => {
    const row = selectCanonRevisionRow(project, path, database)
    return {
      path,
      revision: row?.record_id ?? 'unrecorded',
      op: row?.op ?? 'link',
      reason: row?.reason ?? 'generated canon link',
    }
  })
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
    const history = selectCanonRevisionRow(input.project, write.path, input.database)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path: write.path,
      operation: 'write',
      commit: input.lastPathCommit(write.path),
      rowRevisionAt: history?.at ?? null,
      removalAt: null,
      newestCanonAt: newestCanonRevisionAt(input.project, input.database ?? db()),
    })
    if (refusal) throw new Error(refusal)
  }
  for (const path of input.plan.deletes) {
    if (isGeneratedCanonOutputPath(path)) continue
    const history = selectCanonRevisionRow(input.project, path, input.database)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path,
      operation: 'delete',
      commit: input.lastPathCommit(path),
      rowRevisionAt: history?.at ?? null,
      removalAt:
        history && (history.op === 'delete' || history.status !== 'current') ? history.at : null,
      newestCanonAt: newestCanonRevisionAt(input.project, input.database ?? db()),
    })
    if (refusal) throw new Error(refusal)
  }
}
