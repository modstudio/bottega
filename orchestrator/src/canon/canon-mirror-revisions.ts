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

export type CanonMirrorRevisionSnapshot = {
  project: string
  projectRows: Map<string, CanonRevisionRow>
  globalRows: Map<string, CanonRevisionRow>
  newestAt: string | null
}

export async function canonMirrorRevisionSnapshot(
  project: string,
): Promise<CanonMirrorRevisionSnapshot> {
  const rows = await readDocs({ scope: 'canon' })
  const revisions = await Promise.all(
    rows
      .filter(({ subject, revision }) => revision && (subject === project || subject === null))
      .map(async (doc) => ({ doc, revision: await readDocRevision(doc.revision!) })),
  )
  const projectRows = new Map<string, CanonRevisionRow>()
  const globalRows = new Map<string, CanonRevisionRow>()
  for (const { doc, revision } of revisions) {
    if (!revision) continue
    const row = {
      record_id: revision.record_id,
      op: revision.op,
      reason: revision.reason,
      at: revision.at,
      status: revision.status,
    }
    ;(doc.subject === project ? projectRows : globalRows).set(doc.slug, row)
  }
  return {
    project,
    projectRows,
    globalRows,
    newestAt:
      [...projectRows.values(), ...globalRows.values()]
        .map(({ at }) => at)
        .sort()
        .at(-1) ?? null,
  }
}

function selectCanonRevisionRow(
  snapshot: CanonMirrorRevisionSnapshot,
  path: string,
): CanonRevisionRow | null {
  return snapshot.projectRows.get(path) ?? snapshot.globalRows.get(path) ?? null
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
  snapshot: CanonMirrorRevisionSnapshot,
  paths: string[],
): MirrorRevision[] {
  return paths.map((path) => {
    const row = selectCanonRevisionRow(snapshot, path)
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
  revisions: CanonMirrorRevisionSnapshot
  base: string
  plan: HydrationPlan
  rows: Array<{ slug: string; subject: string | null }>
  lastPathCommit(path: string): { sha: string; at: string } | null
}): void {
  for (const write of input.plan.writes) {
    const row = input.rows.find((candidate) => candidate.slug === write.path)
    if (!row) continue // generated output has no independently adoptable store slug
    const history = selectCanonRevisionRow(input.revisions, write.path)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path: write.path,
      operation: 'write',
      commit: input.lastPathCommit(write.path),
      rowRevisionAt: history?.at ?? null,
      removalAt: null,
      newestCanonAt: input.revisions.newestAt,
    })
    if (refusal) throw new Error(refusal)
  }
  for (const path of input.plan.deletes) {
    if (isGeneratedCanonOutputPath(path)) continue
    const history = selectCanonRevisionRow(input.revisions, path)
    const refusal = canonMirrorRevertRefusal({
      project: input.project,
      path,
      operation: 'delete',
      commit: input.lastPathCommit(path),
      rowRevisionAt: history?.at ?? null,
      removalAt:
        history && (history.op === 'delete' || history.status !== 'current') ? history.at : null,
      newestCanonAt: input.revisions.newestAt,
    })
    if (refusal) throw new Error(refusal)
  }
}
