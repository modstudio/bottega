// concern: record-push-docs
/** One-time upload of the local doc store and a verdict count report. Must not know HTTP internals. */

import type { DocAudience } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db, writableDb } from '../database/db.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import type { RecordApiClient, RecordDocImportInput } from './record-api-client.ts'
import { recordApiClient } from './record-api-client.ts'

type Presentation = { log(value: string): void }

type LocalDoc = {
  id: number
  record_id: string | null
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  title: string
  body: string
  delivery: DocDelivery
  audience: DocAudience
  parent_id: number | null
  position: number
  project_id: number | null
  created_at: string
  updated_at: string
}

type LocalRevision = {
  id: number
  doc_id: number
  record_id: string | null
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  delivery: DocDelivery
  audience: DocAudience
  parent_id: number | null
  position: number
  author: string
  reason: string
  session_id: string | null
  at: string
  project_id: number | null
}

type ImportGroup = {
  localDocId: number | null
  sourceDocId: number
  localParentId: number | null
  localRevisionIds: number[]
  localRevisionParentIds: Array<number | null>
  payload: RecordDocImportInput
}

function bodyHash(body: string): string {
  return new Bun.CryptoHasher('sha256').update(body).digest('hex')
}

function address(scope: string, subject: string | null, slug: string): string {
  return `${scope}/${subject ?? ''}/${slug}`
}

function projectNames(local: ReturnType<typeof db>): Map<number, string> {
  const names = new Map<number, string>()
  for (const row of local
    .query<{ id: number; name: string }, []>('SELECT id, name FROM project')
    .all()) {
    names.set(row.id, row.name)
  }
  return names
}

function asRevision(
  row: LocalRevision,
  recordIds: Map<number, string>,
): RecordDocImportInput['revisions'][number] {
  return {
    scope: row.scope,
    subject: row.subject,
    owner: row.owner,
    slug: row.slug,
    op: row.op,
    title: row.title,
    body: row.body,
    delivery: row.delivery,
    audience: row.audience,
    parentId: row.parent_id == null ? null : (recordIds.get(row.parent_id) ?? null),
    position: row.position,
    featured: row.featured,
    author: row.author,
    reason: row.reason,
    sessionId: row.session_id,
    at: row.at,
  }
}

function groupFromLive(
  doc: LocalDoc,
  revisions: LocalRevision[],
  names: Map<number, string>,
  recordIds: Map<number, string>,
): ImportGroup {
  return {
    localDocId: doc.id,
    sourceDocId: doc.id,
    localParentId: doc.parent_id,
    localRevisionIds: revisions.map((row) => row.id),
    localRevisionParentIds: revisions.map((row) => row.parent_id),
    payload: {
      expectedRevision: revisions.at(-1)?.record_id ?? undefined,
      doc: {
        id: recordIds.get(doc.id)!,
        scope: doc.scope,
        subject: doc.subject,
        owner: doc.owner,
        slug: doc.slug,
        title: doc.title,
        body: doc.body,
        delivery: doc.delivery,
        audience: doc.audience,
        parentId: doc.parent_id == null ? null : (recordIds.get(doc.parent_id) ?? null),
        position: doc.position,
        featured: doc.featured,
        projectName: doc.project_id == null ? null : (names.get(doc.project_id) ?? null),
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        deletedAt: null,
      },
      revisions: revisions.map((row) => asRevision(row, recordIds)),
    },
  }
}

function groupFromDeleted(
  revisions: LocalRevision[],
  names: Map<number, string>,
  recordIds: Map<number, string>,
): ImportGroup {
  const ordered = [...revisions].sort((left, right) => {
    const byAt = left.at.localeCompare(right.at)
    return byAt !== 0 ? byAt : left.id - right.id
  })
  const last = ordered.at(-1)!
  const deleted = [...ordered].reverse().find((row) => row.op === 'delete') ?? last
  const projectId = last.project_id ?? deleted.project_id
  return {
    localDocId: null,
    sourceDocId: last.doc_id,
    localParentId: last.parent_id,
    localRevisionIds: revisions.map((row) => row.id),
    localRevisionParentIds: revisions.map((row) => row.parent_id),
    payload: {
      expectedRevision: revisions.at(-1)?.record_id ?? undefined,
      doc: {
        id: recordIds.get(last.doc_id)!,
        scope: last.scope,
        subject: last.subject,
        owner: last.owner,
        slug: last.slug,
        title: last.title,
        body: last.body,
        delivery: last.delivery,
        audience: last.audience,
        parentId: last.parent_id == null ? null : (recordIds.get(last.parent_id) ?? null),
        position: last.position,
        projectName: projectId == null ? null : (names.get(projectId) ?? null),
        createdAt: ordered[0]!.at,
        updatedAt: deleted.at,
        deletedAt: deleted.at,
      },
      revisions: revisions.map((row) => asRevision(row, recordIds)),
    },
  }
}

export function groupLocalDocsForImport(local: ReturnType<typeof db> = db()): ImportGroup[] {
  const names = projectNames(local)
  const docs = local
    .query<LocalDoc, []>(
      `SELECT id, record_id, scope, subject, owner, slug, title, body, delivery, audience, parent_id, position, project_id, created_at, updated_at
       FROM doc ORDER BY id`,
    )
    .all()
  const revisions = local
    .query<LocalRevision, []>(
      `SELECT id, doc_id, record_id, scope, subject, owner, slug, op, title, body, delivery, audience, parent_id, position, author, reason,
              session_id, at, project_id
       FROM doc_revision ORDER BY id`,
    )
    .all()
  const byDoc = new Map<number, LocalRevision[]>()
  for (const revision of revisions) {
    const list = byDoc.get(revision.doc_id) ?? []
    list.push(revision)
    byDoc.set(revision.doc_id, list)
  }
  const groups: ImportGroup[] = []
  const recordIds = new Map<number, string>()
  for (const doc of docs) recordIds.set(doc.id, doc.record_id ?? newRecordId())
  for (const revision of revisions) {
    if (!recordIds.has(revision.doc_id)) recordIds.set(revision.doc_id, newRecordId())
  }
  const seen = new Set<number>()
  for (const doc of docs) {
    seen.add(doc.id)
    groups.push(groupFromLive(doc, byDoc.get(doc.id) ?? [], names, recordIds))
  }
  for (const [docId, list] of byDoc) {
    if (seen.has(docId) || list.length === 0) continue
    groups.push(groupFromDeleted(list, names, recordIds))
  }
  const byLocalId = new Map(groups.map((group) => [group.sourceDocId, group]))
  const ordered: ImportGroup[] = []
  const visited = new Set<number>()
  const visit = (group: ImportGroup): void => {
    const id = group.sourceDocId
    if (visited.has(id)) return
    visited.add(id)
    const parent = group.localParentId
    if (parent) {
      const parentGroup = byLocalId.get(parent)
      if (parentGroup) visit(parentGroup)
    }
    ordered.push(group)
  }
  for (const group of groups) visit(group)
  return ordered
}

function payloadWithImportedParentIds(
  group: ImportGroup,
  importedIds: Map<number, string>,
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
): Promise<string[]> {
  const docs = local
    .query<LocalDoc, []>(
      `SELECT id, record_id, scope, subject, owner, slug, title, body, delivery, project_id, created_at, updated_at
       FROM doc ORDER BY id`,
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
      hosted = await client.getDoc(doc.record_id)
    } catch {
      mismatches.push(`${label}: hosted row is absent`)
      continue
    }
    const hostedBody = typeof hosted.body === 'string' ? hosted.body : ''
    const localHash = bodyHash(doc.body)
    const hostedHash = bodyHash(hostedBody)
    if (localHash !== hostedHash) {
      mismatches.push(`${label}: body hash ${localHash} != ${hostedHash}`)
    }
    if (hosted.delivery !== doc.delivery) {
      mismatches.push(`${label}: delivery ${doc.delivery} != ${String(hosted.delivery)}`)
    }
    if (hosted.deletedAt != null) {
      mismatches.push(`${label}: deleted_at ${String(hosted.deletedAt)}`)
    }
  }
  return mismatches
}

function recordReturnedIds(
  local: ReturnType<typeof db>,
  group: ImportGroup,
  hosted: { id: string; revisionIds: string[] },
): void {
  if (group.localDocId != null) {
    local.query('UPDATE doc SET record_id=? WHERE id=?').run(hosted.id, group.localDocId)
  }
  for (const [index, revisionId] of group.localRevisionIds.entries()) {
    const hostedRevisionId = hosted.revisionIds[index]
    if (!hostedRevisionId) continue
    local.query('UPDATE doc_revision SET record_id=? WHERE id=?').run(hostedRevisionId, revisionId)
  }
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
  const importedIds = new Map<number, string>()
  for (const group of groups) importedIds.set(group.sourceDocId, group.payload.doc.id!)
  for (const group of groups) {
    const hosted = await client.importDoc(payloadWithImportedParentIds(group, importedIds))
    importedIds.set(group.sourceDocId, hosted.id)
    recordReturnedIds(local, group, hosted)
  }
  const hosted = await client.counts()
  presentation.log(
    `hosted docs ${hosted.docs}, revisions ${hosted.revisions}, scores ${hosted.scores}, voids ${hosted.voids}`,
  )
  const mismatches = await compareLiveDocs(local, client)
  for (const mismatch of mismatches) presentation.log(mismatch)
  if (mismatches.length) throw new Error('hosted docs do not match local live docs')
}
