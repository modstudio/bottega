// concern: record-push-docs
/** One-time upload of the local doc store and a verdict count report. Must not know HTTP internals. */

import type { DocForm, DocKind, DocStatus } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db, writableDb } from '../database/db.ts'
import { decodeStoredDocAudiences } from '../doc/doc-audiences-codec.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import { projectRowByName } from '../project/projects.ts'
import type {
  RecordApiClient,
  RecordDocImportInput,
  RecordRequestDestination,
} from './record-api-client.ts'
import { recordApiClient } from './record-api-client.ts'
import { recordDocArticleCompatibilityRefusal } from './record-doc-transport-contract.ts'
import { noActiveRecordSpaceRefusal } from './record-project-destination.ts'
import { requireProjectRecordDestination } from './record-project-destination-client.ts'

type Presentation = { log(value: string): void }

function carriedArticleFields(input: {
  form: DocForm | null
  articleSubjectId: string | null
  relatedSubjectIds: string[]
  sourceFiles: string[]
  checkedAgainstCommit: string | null
  summary: string | null
}): Partial<
  Pick<
    RecordDocImportInput['doc'],
    | 'form'
    | 'articleSubjectId'
    | 'relatedSubjectIds'
    | 'sourceFiles'
    | 'checkedAgainstCommit'
    | 'summary'
  >
> {
  return {
    ...(input.form ? { form: input.form } : {}),
    ...(input.articleSubjectId ? { articleSubjectId: input.articleSubjectId } : {}),
    ...(input.relatedSubjectIds.length ? { relatedSubjectIds: input.relatedSubjectIds } : {}),
    ...(input.sourceFiles.length ? { sourceFiles: input.sourceFiles } : {}),
    ...(input.checkedAgainstCommit ? { checkedAgainstCommit: input.checkedAgainstCommit } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  }
}

type LocalDoc = {
  record_id: string
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  title: string
  body: string
  delivery: DocDelivery
  audiences: string
  parent_record_id: string | null
  position: number
  featured: boolean
  status: DocStatus
  kind: DocKind
  form: DocForm | null
  article_subject_id: string | null
  source_files: string
  checked_against_commit: string | null
  summary: string | null
  replacement_slug: string | null
  project_record_id: string | null
  created_at: string
  updated_at: string
}

type LocalRevision = {
  record_id: string
  number: number
  doc_record_id: string | null
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  delivery: DocDelivery
  audiences: string
  parent_record_id: string | null
  position: number
  featured: boolean
  status: DocStatus
  kind: DocKind
  form: DocForm | null
  article_subject_id: string | null
  related_subject_ids: string
  source_files: string
  checked_against_commit: string | null
  summary: string | null
  replacement_slug: string | null
  author: string
  reason: string
  session_id: string | null
  at: string
  project_record_id: string | null
}

type ImportGroup = {
  localDocId: string | null
  sourceDocId: string
  localParentId: string | null
  localRevisionIds: string[]
  localRevisionParentIds: Array<string | null>
  payload: RecordDocImportInput
}

function bodyHash(body: string): string {
  return new Bun.CryptoHasher('sha256').update(body).digest('hex')
}

function address(scope: string, subject: string | null, slug: string): string {
  return `${scope}/${subject ?? ''}/${slug}`
}

function lifecycleAddress(input: {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
}): string {
  return `${input.scope}\0${input.subject ?? ''}\0${input.owner ?? ''}\0${input.slug}`
}

function projectNames(local: ReturnType<typeof db>): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of local
    .query<{ record_id: string; name: string }, []>('SELECT record_id, name FROM project')
    .all()) {
    names.set(row.record_id, row.name)
  }
  return names
}

function projectRecordIds(local: ReturnType<typeof db>): Map<string, string> {
  return new Map(
    local
      .query<{ record_id: string }, []>('SELECT record_id FROM project')
      .all()
      .map((row) => [row.record_id, row.record_id]),
  )
}

function asRevision(row: LocalRevision): RecordDocImportInput['revisions'][number] {
  return {
    id: row.record_id,
    scope: row.scope,
    subject: row.subject,
    owner: row.owner,
    slug: row.slug,
    op: row.op,
    title: row.title,
    body: row.body,
    delivery: row.delivery,
    audiences: decodeStoredDocAudiences(row.audiences),
    parentId: row.parent_record_id,
    position: row.position,
    featured: Boolean(row.featured),
    status: row.status,
    kind: row.kind,
    ...carriedArticleFields({
      form: row.form,
      articleSubjectId: row.article_subject_id,
      relatedSubjectIds: JSON.parse(row.related_subject_ids),
      sourceFiles: JSON.parse(row.source_files),
      checkedAgainstCommit: row.checked_against_commit,
      summary: row.summary,
    }),
    replacementSlug: row.replacement_slug,
    author: row.author,
    reason: row.reason,
    sessionId: row.session_id,
    at: row.at,
  }
}

function groupFromLive(
  doc: LocalDoc,
  revisions: LocalRevision[],
  names: Map<string, string>,
  projectIds: Map<string, string>,
  relatedIds: string[],
): ImportGroup {
  return {
    localDocId: doc.record_id,
    sourceDocId: doc.record_id,
    localParentId: doc.parent_record_id,
    localRevisionIds: revisions.map((row) => row.record_id),
    localRevisionParentIds: revisions.map((row) => row.parent_record_id),
    payload: {
      expectedRevision: revisions.at(-1)?.record_id ?? undefined,
      doc: {
        id: doc.record_id,
        scope: doc.scope,
        subject: doc.subject,
        owner: doc.owner,
        slug: doc.slug,
        title: doc.title,
        body: doc.body,
        delivery: doc.delivery,
        audiences: decodeStoredDocAudiences(doc.audiences),
        parentId: doc.parent_record_id,
        position: doc.position,
        featured: Boolean(doc.featured),
        status: doc.status,
        kind: doc.kind,
        ...carriedArticleFields({
          form: doc.form,
          articleSubjectId: doc.article_subject_id,
          relatedSubjectIds: relatedIds,
          sourceFiles: JSON.parse(doc.source_files),
          checkedAgainstCommit: doc.checked_against_commit,
          summary: doc.summary,
        }),
        replacementSlug: doc.replacement_slug,
        projectName:
          doc.project_record_id == null ? null : (names.get(doc.project_record_id) ?? null),
        projectId:
          doc.project_record_id == null ? null : (projectIds.get(doc.project_record_id) ?? null),
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        deletedAt: null,
      },
      revisions: revisions.map((row) => asRevision(row)),
    },
  }
}

function groupFromDeleted(
  revisions: LocalRevision[],
  names: Map<string, string>,
  projectIds: Map<string, string>,
): ImportGroup {
  const ordered = [...revisions].sort((left, right) => {
    const byAt = left.at.localeCompare(right.at)
    return byAt !== 0 ? byAt : left.number - right.number
  })
  const last = ordered.at(-1)!
  const deleted = [...ordered].reverse().find((row) => row.op === 'delete') ?? last
  const projectId = last.project_record_id ?? deleted.project_record_id
  return {
    localDocId: null,
    sourceDocId: lifecycleAddress(last),
    localParentId: last.parent_record_id,
    localRevisionIds: revisions.map((row) => row.record_id),
    localRevisionParentIds: revisions.map((row) => row.parent_record_id),
    payload: {
      expectedRevision: revisions.at(-1)?.record_id ?? undefined,
      doc: {
        id: newRecordId(),
        scope: last.scope,
        subject: last.subject,
        owner: last.owner,
        slug: last.slug,
        title: last.title,
        body: last.body,
        delivery: last.delivery,
        audiences: decodeStoredDocAudiences(last.audiences),
        ...carriedArticleFields({
          form: last.form,
          articleSubjectId: last.article_subject_id,
          relatedSubjectIds: JSON.parse(last.related_subject_ids),
          sourceFiles: JSON.parse(last.source_files),
          checkedAgainstCommit: last.checked_against_commit,
          summary: last.summary,
        }),
        featured: Boolean(last.featured),
        parentId: last.parent_record_id,
        position: last.position,
        projectName: projectId == null ? null : (names.get(projectId) ?? null),
        projectId: projectId == null ? null : (projectIds.get(projectId) ?? null),
        createdAt: ordered[0]!.at,
        updatedAt: deleted.at,
        deletedAt: deleted.at,
      },
      revisions: revisions.map((row) => asRevision(row)),
    },
  }
}

export function groupLocalDocsForImport(local: ReturnType<typeof db> = db()): ImportGroup[] {
  const names = projectNames(local)
  const projectIds = projectRecordIds(local)
  const docs = local
    .query<LocalDoc, []>(
      `SELECT record_id, scope, subject, owner, slug, title, body, delivery, audiences, featured, status, kind, form, article_subject_id, source_files, checked_against_commit, summary, replacement_slug, parent_record_id, position, project_record_id, created_at, updated_at
       FROM doc ORDER BY record_id`,
    )
    .all()
  const revisions = local
    .query<LocalRevision, []>(
      `SELECT record_id, number, doc_record_id, scope, subject, owner, slug, op, title, body, delivery, audiences, featured, status, kind, form, article_subject_id, related_subject_ids, source_files, checked_against_commit, summary, replacement_slug, parent_record_id, position, author, reason,
              session_id, at, project_record_id
       FROM doc_revision ORDER BY number`,
    )
    .all()
  const byDoc = new Map<string, LocalRevision[]>()
  for (const revision of revisions) {
    const key = revision.doc_record_id ?? lifecycleAddress(revision)
    const list = byDoc.get(key) ?? []
    list.push(revision)
    byDoc.set(key, list)
  }
  const groups: ImportGroup[] = []
  const relatedByDoc = new Map<string, string[]>()
  for (const row of local
    .query<{ doc_id: string; subject_id: string }, []>(
      'SELECT d.record_id AS doc_id,r.subject_id FROM doc d JOIN doc_related_subject r ON r.doc_record_id=d.record_id ORDER BY d.record_id',
    )
    .all()) {
    relatedByDoc.set(row.doc_id, [...(relatedByDoc.get(row.doc_id) ?? []), row.subject_id])
  }
  const seen = new Set<string>()
  for (const doc of docs) {
    seen.add(doc.record_id)
    groups.push(
      groupFromLive(
        doc,
        byDoc.get(doc.record_id) ?? [],
        names,
        projectIds,
        relatedByDoc.get(doc.record_id) ?? [],
      ),
    )
  }
  for (const [docId, list] of byDoc) {
    if (seen.has(docId) || list.length === 0) continue
    groups.push(groupFromDeleted(list, names, projectIds))
  }
  const byLocalId = new Map(groups.map((group) => [group.sourceDocId, group]))
  const liveByAddress = new Map(
    groups
      .filter((group) => group.localDocId !== null)
      .map((group) => [lifecycleAddress(group.payload.doc), group]),
  )
  const ordered: ImportGroup[] = []
  const visited = new Set<string>()
  const visit = (group: ImportGroup): void => {
    const id = group.sourceDocId
    if (visited.has(id)) return
    visited.add(id)
    const parent = group.localParentId
    if (parent) {
      const parentGroup = byLocalId.get(parent)
      if (parentGroup) visit(parentGroup)
    }
    const replacement = group.payload.doc.replacementSlug
    if (group.localDocId !== null && group.payload.doc.status === 'superseded' && replacement) {
      const replacementGroup = liveByAddress.get(
        lifecycleAddress({ ...group.payload.doc, slug: replacement }),
      )
      if (replacementGroup) visit(replacementGroup)
    }
    ordered.push(group)
  }
  for (const group of groups) visit(group)
  return ordered
}

function payloadWithImportedParentIds(
  group: ImportGroup,
  importedIds: Map<string, string>,
): RecordDocImportInput {
  return {
    ...group.payload,
    doc: {
      ...group.payload.doc,
      parentId: group.localParentId == null ? null : (importedIds.get(group.localParentId) ?? null),
    },
    revisions: group.payload.revisions.map((revision, index) => ({
      ...revision,
      parentId:
        group.localRevisionParentIds[index] == null
          ? null
          : (importedIds.get(group.localRevisionParentIds[index]!) ?? null),
    })),
  }
}

async function compareLiveDocs(
  local: ReturnType<typeof db>,
  client: RecordApiClient,
  destinations: Map<string | null, RecordRequestDestination>,
): Promise<string[]> {
  const docs = local
    .query<LocalDoc, []>(
      `SELECT record_id, scope, subject, owner, slug, title, body, delivery, status, kind, summary, replacement_slug, project_record_id, created_at, updated_at
       FROM doc ORDER BY scope,subject,slug`,
    )
    .all()
  const mismatches: string[] = []
  for (const doc of docs) {
    const label = address(doc.scope, doc.subject, doc.slug)
    if (!doc.record_id) {
      mismatches.push(`${label}: missing hosted id`)
      continue
    }
    let hosted: Record<string, unknown>
    try {
      const projectName =
        doc.project_record_id == null
          ? null
          : (local
              .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
              .get(doc.project_record_id)?.name ?? null)
      hosted = await client.getDoc(doc.record_id, destinations.get(projectName))
    } catch {
      mismatches.push(`${label}: hosted row is absent`)
      continue
    }
    mismatches.push(...liveDocMismatches(label, doc, hosted))
  }
  return mismatches
}

function liveDocMismatches(
  label: string,
  doc: LocalDoc,
  hosted: Record<string, unknown>,
): string[] {
  const mismatches: string[] = []
  const hostedBody = typeof hosted.body === 'string' ? hosted.body : ''
  const localHash = bodyHash(doc.body)
  const hostedHash = bodyHash(hostedBody)
  if (localHash !== hostedHash) {
    mismatches.push(`${label}: body hash ${localHash} != ${hostedHash}`)
  }
  if (hosted.delivery !== doc.delivery) {
    mismatches.push(`${label}: delivery ${doc.delivery} != ${String(hosted.delivery)}`)
  }
  if (hosted.status !== doc.status) {
    mismatches.push(`${label}: status ${doc.status} != ${String(hosted.status)}`)
  }
  if (hosted.kind !== doc.kind) {
    mismatches.push(`${label}: kind ${doc.kind} != ${String(hosted.kind)}`)
  }
  if ((hosted.summarySource === 'written' ? hosted.summary : null) !== doc.summary) {
    mismatches.push(
      `${label}: summary ${doc.summary ?? 'null'} != ${String(hosted.summarySource === 'written' ? hosted.summary : null)}`,
    )
  }
  if ((hosted.replacementSlug ?? null) !== doc.replacement_slug) {
    mismatches.push(
      `${label}: replacement ${doc.replacement_slug ?? 'null'} != ${String(hosted.replacementSlug ?? null)}`,
    )
  }
  if (hosted.deletedAt != null) {
    mismatches.push(`${label}: deleted_at ${String(hosted.deletedAt)}`)
  }
  return mismatches
}

function recordReturnedIds(
  group: ImportGroup,
  hosted: { id: string; revisionIds: string[] },
): void {
  if (group.localDocId != null && hosted.id !== group.localDocId)
    throw new Error(
      `hosted document identity mismatch: submitted ${group.localDocId}, returned ${hosted.id}`,
    )
  for (const [index, revisionId] of group.localRevisionIds.entries()) {
    const hostedRevisionId = hosted.revisionIds[index]
    if (hostedRevisionId !== revisionId)
      throw new Error(
        `hosted document revision identity mismatch: submitted ${revisionId}, returned ${hostedRevisionId ?? 'nothing'}`,
      )
  }
}

async function retainedHostedDocumentId(
  group: ImportGroup,
  client: RecordApiClient,
  destination: RecordRequestDestination,
): Promise<string | null> {
  if (group.localDocId !== null) return group.payload.doc.id ?? null
  let cursor: string | null = null
  do {
    const listed = await client.listDocs(
      {
        scope: group.payload.doc.scope,
        subject: group.payload.doc.subject,
        includeDeleted: true,
        limit: 100,
        cursor,
      },
      destination,
    )
    for (const candidate of listed.items) {
      if (
        candidate.scope !== group.payload.doc.scope ||
        (candidate.subject ?? null) !== group.payload.doc.subject ||
        (candidate.owner ?? null) !== (group.payload.doc.owner ?? null) ||
        candidate.slug !== group.payload.doc.slug ||
        typeof candidate.id !== 'string'
      )
        continue
      const revisions = await client.listRevisions(candidate.id, destination)
      if (revisions.some((revision) => group.localRevisionIds.includes(String(revision.id))))
        return candidate.id
    }
    cursor = listed.nextCursor
  } while (cursor !== null)
  return null
}

export async function pushDocsCommand(
  options: { dryRun: boolean },
  presentation: Presentation,
): Promise<void> {
  const local = db()
  const groups = groupLocalDocsForImport(local)
  const docs = groups.filter((group) => group.localDocId != null).length
  const revisions = groups.reduce((sum, group) => sum + group.localRevisionIds.length, 0)
  const deleted = groups.filter((group) => group.payload.doc.deletedAt != null).length
  const localScores = local.query<{ n: number }, []>('SELECT count(*) AS n FROM score').get()!.n
  const localVoids = local
    .query<{ n: number }, []>('SELECT count(*) AS n FROM run WHERE evidence_excluded IS NOT NULL')
    .get()!.n
  presentation.log(
    `local docs ${docs}, revisions ${revisions}, scores ${localScores}, voids ${localVoids}, deleted ${deleted}`,
  )
  if (options.dryRun) return
  writableDb()
  const client = recordApiClient()
  const identity = await client.whoami()
  if (!identity.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
  const destinations = new Map<string | null, RecordRequestDestination>([
    [null, { destinationSpaceId: identity.activeSpaceId }],
  ])
  const destinationFor = async (projectName: string | null) => {
    const cached = destinations.get(projectName)
    if (cached) return cached
    const project = projectName ? projectRowByName(projectName) : null
    if (!project) throw new Error(`no project "${projectName}"`)
    const destination = {
      destinationSpaceId: await requireProjectRecordDestination(
        project.name,
        project.settings,
        client,
      ),
    }
    destinations.set(projectName, destination)
    return destination
  }
  const importedIds = new Map<string, string>()
  for (const group of groups) {
    if (group.localDocId !== null) importedIds.set(group.sourceDocId, group.payload.doc.id!)
  }
  for (const group of groups) {
    const destination = await destinationFor(group.payload.doc.projectName ?? null)
    if (group.localDocId === null) {
      const retainedId = await retainedHostedDocumentId(group, client, destination)
      group.payload.doc.id = retainedId ?? group.payload.doc.id
      importedIds.set(group.sourceDocId, group.payload.doc.id!)
    }
    const payload = payloadWithImportedParentIds(group, importedIds)
    const hosted = await client.importDoc(payload, destination)
    const compatibilityRefusal = recordDocArticleCompatibilityRefusal(
      [payload.doc, ...payload.revisions],
      hosted,
    )
    if (compatibilityRefusal) throw new Error(compatibilityRefusal)
    importedIds.set(group.sourceDocId, hosted.id)
    recordReturnedIds(group, hosted)
  }
  const hosted = { docs: 0, revisions: 0, scores: 0, voids: 0 }
  const uniqueDestinations = new Map(
    [...destinations.values()].map((destination) => [
      destination.destinationSpaceId ?? null,
      destination,
    ]),
  )
  for (const destination of uniqueDestinations.values()) {
    const counts = await client.counts(destination)
    hosted.docs += counts.docs
    hosted.revisions += counts.revisions
    hosted.scores += counts.scores
    hosted.voids += counts.voids
  }
  presentation.log(
    `hosted docs ${hosted.docs}, revisions ${hosted.revisions}, scores ${hosted.scores}, voids ${hosted.voids}`,
  )
  const mismatches = await compareLiveDocs(local, client, destinations)
  for (const mismatch of mismatches) presentation.log(mismatch)
  if (mismatches.length) throw new Error('hosted docs do not match local live docs')
}
