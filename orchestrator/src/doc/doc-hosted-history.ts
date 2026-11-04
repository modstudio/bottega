// concern: hosted-document-history
/** Reads and presents hosted revisions without copying them into the local revision store. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import type { RecordDocRevision } from '../record/record-doc-mapping.ts'
import { decideHostedRevisionRead } from './doc-history-source.ts'
import type { DocRevision, DocRevisionMetadata } from './doc-read-store.ts'
import { diffDocRevisionValues } from './doc-revision-store.ts'

export type HostedDocRevision = RecordDocRevision
export type HostedDocRevisionRead = {
  revisions: Array<DocRevisionMetadata & { authorName?: string | null }>
  diff(a: string | undefined, b: string | undefined): string
}

type NumberedHostedRevision = DocRevision & { authorName: string | null }

export function mapHostedDocRevisions(
  revisions: readonly HostedDocRevision[],
): NumberedHostedRevision[] {
  const chronological = [...revisions].sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  )
  return chronological
    .map(
      (revision, index): NumberedHostedRevision => ({
        record_id: revision.id,
        number: index + 1,
        doc_record_id: revision.docId,
        scope: revision.scope as DocRevision['scope'],
        subject: revision.subject,
        owner: revision.owner,
        project_record_id: null,
        slug: revision.slug,
        op: revision.op,
        title: revision.title,
        body: revision.body,
        delivery: revision.delivery,
        audiences: revision.audiences,
        featured: revision.featured ?? false,
        status: revision.status ?? 'current',
        kind: revision.kind ?? 'working',
        form: revision.form ?? null,
        article_subject_id: revision.articleSubject?.id ?? null,
        articleSubject: revision.articleSubject ?? null,
        relatedSubjects: revision.relatedSubjects ?? [],
        sourceFiles: revision.sourceFiles ?? [],
        checkedAgainstCommit: revision.checkedAgainstCommit ?? null,
        summary: revision.summary ?? null,
        replacement_slug: revision.replacementSlug ?? null,
        parent_record_id: revision.parentId,
        position: revision.position,
        author: revision.author,
        authorName: revision.authorName,
        reason: revision.reason,
        session_id: revision.sessionId,
        at: revision.at,
      }),
    )
    .reverse()
}

export function hostedRevisionMetadata(
  revisions: readonly NumberedHostedRevision[],
): Array<DocRevisionMetadata & { authorName?: string | null }> {
  return revisions.map((revision) => ({
    number: revision.number,
    record_id: revision.record_id,
    op: revision.op,
    author: revision.author,
    authorName: revision.authorName,
    reason: revision.reason,
    at: revision.at,
    status: revision.status,
    kind: revision.kind,
    form: revision.form,
    articleSubject: revision.articleSubject,
    relatedSubjects: revision.relatedSubjects,
    sourceFiles: revision.sourceFiles,
    checkedAgainstCommit: revision.checkedAgainstCommit,
    summary: revision.summary,
    replacement_slug: revision.replacement_slug,
    bytes: Buffer.byteLength(revision.body),
  }))
}

function hostedRevisionByIdentifier(
  revisions: readonly NumberedHostedRevision[],
  input: string,
): NumberedHostedRevision {
  const numeric = /^[0-9]+$/.test(input) ? Number(input) : null
  const revision =
    numeric !== null && Number.isSafeInteger(numeric) && numeric > 0
      ? revisions.find((candidate) => candidate.number === numeric)
      : revisions.find((candidate) => candidate.record_id.toLowerCase() === input.toLowerCase())
  if (!revision) throw new Error(`no hosted document revision ${JSON.stringify(input)}`)
  return revision
}

export function hostedDocRevisionRead(
  revisions: readonly HostedDocRevision[],
): HostedDocRevisionRead {
  const numbered = mapHostedDocRevisions(revisions)
  return {
    revisions: hostedRevisionMetadata(numbered),
    diff(a, b) {
      const leftId = a ?? numbered[1]?.record_id
      const rightId = b ?? numbered[0]?.record_id
      if (!leftId || !rightId)
        throw new Error('doc diff needs two revisions; this address has fewer than two')
      return diffDocRevisionValues(
        hostedRevisionByIdentifier(numbered, leftId),
        hostedRevisionByIdentifier(numbered, rightId),
      )
    },
  }
}

export async function readHostedDocRevisions(input: {
  address: string
  listRevisions(): Promise<HostedDocRevision[]>
}): Promise<HostedDocRevisionRead | null> {
  try {
    const revisions = await input.listRevisions()
    if (decideHostedRevisionRead('revisions') === 'print-hosted')
      return hostedDocRevisionRead(revisions)
  } catch (error) {
    const outcome =
      error instanceof RecordApiRequestError && error.status === 404 ? 'not-found' : 'failed'
    const decision = decideHostedRevisionRead(outcome)
    if (decision === 'read-local') return null
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `could not read hosted revisions for ${input.address}: ${cause}; run ${PLATFORM_SLUG} record whoami to verify sign-in, or retry when the hosted record is reachable`,
    )
  }
  throw new Error('hosted revision read reached an invalid outcome')
}
