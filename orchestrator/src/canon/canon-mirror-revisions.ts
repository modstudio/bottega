// concern: canon-mirror-revisions
/** Reads the revision timestamps needed by the canon mirror's revert guard. */
import { readDocRevision, readDocs } from '../doc/doc-authoritative-read.ts'
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
async function selectCanonRevisionRow(
  project: string,
  path: string,
): Promise<CanonRevisionRow | null> {
  const rows = await readDocs({ scope: 'canon', slug: path })
  const row = rows.find(({ subject }) => subject === project) ?? rows.find(({ subject }) => subject === null)
  if (!row?.revision) return null
  const revision = await readDocRevision(row.revision)
  return revision
    ? {
        record_id: revision.record_id,
        op: revision.op,
        reason: revision.reason,
        at: revision.at,
        status: revision.status,
      }
    : null
}

async function newestCanonRevisionAt(project: string): Promise<string | null> {
  const rows = await readDocs({ scope: 'canon', status: 'current' })
  const revisions = await Promise.all(
    rows
      .filter(({ subject, revision }) => revision && (subject === project || subject === null))
      .map(({ revision }) => readDocRevision(revision!)),
  )
  return revisions.flatMap((revision) => (revision ? [revision.at] : [])).sort().at(-1) ?? null
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

export async function revisionRows(
  project: string,
  paths: string[],
): Promise<MirrorRevision[]> {
  return Promise.all(paths.map(async (path) => {
    const row = await selectCanonRevisionRow(project, path)
    return {
      path,
      revision: row?.record_id ?? 'unrecorded',
      op: row?.op ?? 'link',
      reason: row?.reason ?? 'generated canon link',
    }
  }))
}

export async function assertHydrationDoesNotRevertBranchCanon(input: {
  project: string
  base: string
  plan: HydrationPlan
  rows: Array<{ slug: string; subject: string | null }>
  lastPathCommit(path: string): { sha: string; at: string } | null
}): Promise<void> {
  const newestCanonAt = await newestCanonRevisionAt(input.project)
  for (const write of input.plan.writes) {
    const row = input.rows.find((candidate) => candidate.slug === write.path)
    if (!row) continue // generated output has no independently adoptable store slug
    const history = await selectCanonRevisionRow(input.project, write.path)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path: write.path,
      operation: 'write',
      commit: input.lastPathCommit(write.path),
      rowRevisionAt: history?.at ?? null,
      removalAt: null,
      newestCanonAt,
    })
    if (refusal) throw new Error(refusal)
  }
  for (const path of input.plan.deletes) {
    if (isGeneratedCanonOutputPath(path)) continue
    const history = await selectCanonRevisionRow(input.project, path)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path,
      operation: 'delete',
      commit: input.lastPathCommit(path),
      rowRevisionAt: history?.at ?? null,
      removalAt:
        history && (history.op === 'delete' || history.status !== 'current') ? history.at : null,
      newestCanonAt,
    })
    if (refusal) throw new Error(refusal)
  }
}
