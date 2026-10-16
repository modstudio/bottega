// concern: record-docs
/** Owns tenant-bound hosted document reads and writes. Must not know local cache, CLI, or HTTP. */

import { SQL } from 'bun'
import { assertDocSections } from '../../../shared/doc-sections.ts'
import type { DocAudiences, DocForm, DocKind, DocStatus } from '../../../shared/docs.ts'
import { bindJsonb } from '../../../shared/record/jsonb-sql.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { planCanonImport } from '../canon/canon-import-policy.ts'
import type { CanonFinding } from '../canon/canon-lint.ts'
import { nonCurrentCanonCollisionRefusal } from '../doc/canon-import-collision.ts'
import type { DocGenerator } from '../doc/doc-generator.ts'
import {
  canonFindingsRefusal,
  consumeDocBody,
  type DocDelivery,
  type DocRevisionOp,
  docWriteProjectName,
  recordDocLintRefusal,
  refuseArticleDelivery,
  refuseDocWrite,
  refuseMismatchedDocProject,
  refuseOwnedDocAddress,
  refuseSettingsAddress,
} from '../doc/doc-write-allowed.ts'
import { canonFacts, recordCanonImportSurroundings } from './record-canon-facts.ts'
import {
  type HostedArticleResponse,
  hostedArticleProjectId,
  hostedArticleResponse,
  importedArticleSubjectNames,
  replaceHostedRelatedSubjects,
  resolveHostedArticleFields,
  restoredArticleFields,
  storedRevisionArticleFields,
} from './record-doc-article-fields.ts'
import { bindRecordDocAudiences } from './record-doc-audience-sql.ts'
import { recordDocAudiences } from './record-doc-audiences.ts'
import { assertRevisionWrite, assertWrite, RecordDocError } from './record-doc-errors.ts'
import { writeImportedRecordDoc } from './record-doc-import-write.ts'
import {
  recordDocumentLifecycle,
  validateImportedDocumentLifecycles,
} from './record-doc-lifecycle.ts'
import {
  importedLiveArticleFields,
  newerHostedImportRefusal,
  normalizeRecordDocImport,
  type RecordDocImportInput,
  recordDocRevisionIdentityRefusal,
} from './record-doc-mapping.ts'
import { type RecordDocOrder, reorderRecordDocRows } from './record-doc-order.ts'
import {
  assertHostedReferenceImportAllowed,
  assertHostedReferenceLintAllowed,
  assertHostedReferenceUpsertAllowed,
  assertHostedStoredReferenceWriteAllowed,
} from './record-doc-reference-write.ts'
import { insertRecordDocRevision } from './record-doc-revision-write.ts'
import {
  storedDocAudiences,
  storedDocDelivery,
  storedDocKind,
  storedDocParentId,
} from './record-doc-stored-fields.ts'
import {
  existingDocAtAddress,
  recordCanonTreeWriteRefusal,
  recordTreeWriteRefusal,
} from './record-doc-tree.ts'

export { RecordDocError } from './record-doc-errors.ts'
export type { RecordDoc, RecordDocImportInput, RecordDocRevision } from './record-doc-mapping.ts'
export {
  getRecordDoc,
  listRecordDocRevisions,
  listRecordDocs,
  type RecordDocListInput,
} from './record-doc-read.ts'

export type RecordCanonImportInput = {
  address: { kind: 'user' } | { kind: 'project'; subject: string }
  rows: Array<{ slug: string; title: string; body: string }>
  expectedRevisions: Record<string, string>
  reason: string
  author: string
}

export type RecordCanonImportResult = {
  rows: Array<{ slug: string; id: string; revisionId: string }>
  deletions: Array<{ slug: string; id: string; revisionId: string }>
  findings: CanonFinding[]
  bootstrap: boolean
}

type Tenant = { url: string } & TenantPrincipal
type StoredDocRow = Record<string, unknown>

export type RecordDocOrderInput = Omit<RecordDocOrder, 'spaceId'>

async function tenant<T>(input: Tenant, read: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export async function reorderRecordDocs(
  input: Tenant & RecordDocOrderInput,
): Promise<{ orderedIds: string[] }> {
  return reorderRecordDocRows(input)
}

type RecordDocWriteInput = Tenant & {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  title: string
  body: string
  delivery?: DocDelivery
  audiences?: DocAudiences
  parentRecordId?: string | null
  position?: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  form?: DocForm | null
  articleSubjectId?: string | null
  relatedSubjectIds?: string[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
  replacementSlug?: string | null
  projectName?: string | null
  projectId?: string | null
  reason: string
  author: string
  sessionId?: string | null
  forceInject?: string
  op?: DocRevisionOp
  at?: string
  id?: string
  revisionId?: string
  expectedRevision?: string
  generator?: DocGenerator
}

function assertUpsertAddress(input: RecordDocWriteInput): void {
  const refusal =
    refuseOwnedDocAddress(input.scope, input.subject, input.owner) ??
    refuseSettingsAddress(input.scope, input.subject, input.owner)
  if (refusal) throw new RecordDocError(refusal)
  assertWrite(refuseMismatchedDocProject(input.scope, input.subject, input.projectName))
}

function resolvedDocProjectId(
  tx: SQL,
  spaceId: string,
  doc: Pick<RecordDocWriteInput, 'scope' | 'subject' | 'projectName' | 'projectId'>,
): Promise<string | null> {
  const name = doc.projectName ?? docWriteProjectName(doc.scope, doc.subject)
  return hostedArticleProjectId(tx, spaceId, name, doc.projectId)
}

export async function upsertRecordDoc(
  input: RecordDocWriteInput,
): Promise<{ id: string; revisionId: string } & HostedArticleResponse> {
  assertUpsertAddress(input)
  return tenant(input, async (tx) => {
    const existing = await tx`
      SELECT id, scope, subject, owner_user_id, slug, body, delivery, audiences, featured, status, kind, form, article_subject_id, source_files, checked_against_commit, replacement_slug, parent_id, position, latest_revision_id FROM doc
      WHERE space_id=${input.spaceId}::uuid
        AND scope=${input.scope}
        AND COALESCE(subject, '')=${input.subject ?? ''}
        AND COALESCE(owner_user_id::text, '')=${input.owner ?? ''}
        AND slug=${input.slug}
        AND deleted_at IS NULL
      FOR UPDATE
    `
    assertHostedReferenceUpsertAllowed(existing[0], input)
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: existing[0]?.latest_revision_id,
      isCreate: !existing[0],
      scope: input.scope,
    })
    const facts = await canonFacts(
      tx,
      input.spaceId,
      input.scope,
      input.subject,
      input.slug,
      input.body,
      input.owner ?? null,
    )
    assertWrite(facts.canonRefusal)
    const delivery = storedDocDelivery(input, existing[0])
    assertWrite(
      refuseDocWrite({
        scope: input.scope,
        subject: input.subject,
        slug: input.slug,
        body: input.body,
        delivery,
        forceInject: input.forceInject,
        packBytes: 0,
        ...facts,
      }),
    )
    const kind = storedDocKind(input, existing[0])
    if (!existing[0] && kind === 'article' && input.audiences === undefined) {
      throw new RecordDocError(
        'creating an article requires audiences; supply the audiences parameter',
      )
    }
    assertWrite(refuseArticleDelivery({ ...input, delivery, kind }))
    assertHostedReferenceLintAllowed(existing[0], input, kind)
    const resolvedProject = await resolvedDocProjectId(tx, input.spaceId, input)
    const articleFields = await resolveHostedArticleFields(
      tx,
      { ...input, kind },
      existing[0],
      resolvedProject,
    )
    const now = input.at ?? new Date().toISOString()
    const docId = existing[0] ? String(existing[0].id) : (input.id ?? newRecordId())
    const audiences = storedDocAudiences(input, existing[0])
    assertDocSections(input.body, audiences)
    const parentId = storedDocParentId(input, existing[0])
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id: docId,
        slug: input.slug,
        scope: input.scope,
        subject: input.subject,
        owner: input.owner ?? null,
        audiences,
        parentId,
        parentWasSpecified: input.parentRecordId !== undefined,
      }),
    )
    const position =
      input.position ?? (existing[0]?.position == null ? 0 : Number(existing[0].position))
    const featured =
      input.featured ?? (existing[0]?.featured == null ? false : Boolean(existing[0].featured))
    const { status, replacementSlug } = await recordDocumentLifecycle(tx, input, existing[0])
    const op: DocRevisionOp = input.op ?? (existing[0] ? 'set' : 'create')
    if (existing[0]) {
      await tx`
        UPDATE doc
        SET title=${input.title}, body=${input.body}, delivery=${delivery},
            audiences=${bindRecordDocAudiences(tx, audiences)}, featured=${featured}, status=${status}, kind=${kind}, form=${articleFields.form}, article_subject_id=${articleFields.articleSubjectId}::uuid, source_files=${bindJsonb(tx, articleFields.sourceFiles)}, checked_against_commit=${articleFields.checkedAgainstCommit}, replacement_slug=${replacementSlug}, parent_id=${parentId}::uuid, position=${position},
            owner_user_id=${input.owner ?? null}::uuid,
            project_id=${resolvedProject}::uuid, updated_at=${now}::timestamptz
        WHERE id=${docId}::uuid AND space_id=${input.spaceId}::uuid
      `
    } else {
      await tx`
        INSERT INTO doc (
          id, space_id, scope, subject, owner_user_id, slug, title, body, delivery, audiences, featured, status, kind, form, article_subject_id, source_files, checked_against_commit, replacement_slug, parent_id, position, project_id, created_at, updated_at
        ) VALUES (
          ${docId}::uuid, ${input.spaceId}::uuid, ${input.scope}, ${input.subject}, ${input.owner ?? null}::uuid, ${input.slug},
          ${input.title}, ${input.body}, ${delivery}, ${bindRecordDocAudiences(tx, audiences)}, ${featured}, ${status}, ${kind}, ${articleFields.form}, ${articleFields.articleSubjectId}::uuid, ${bindJsonb(tx, articleFields.sourceFiles)}, ${articleFields.checkedAgainstCommit}, ${replacementSlug}, ${parentId}::uuid, ${position}, ${resolvedProject}::uuid,
          ${now}::timestamptz, ${now}::timestamptz
        )
      `
    }
    await replaceHostedRelatedSubjects(tx, input.spaceId, docId, articleFields.relatedSubjectIds)
    const revisionId = await insertRecordDocRevision(tx, {
      id: input.revisionId,
      spaceId: input.spaceId,
      docId,
      scope: input.scope,
      subject: input.subject,
      owner: input.owner ?? null,
      slug: input.slug,
      projectId: resolvedProject,
      op,
      title: input.title,
      body: input.body,
      delivery,
      audiences,
      parentId,
      position,
      featured,
      status,
      kind,
      form: articleFields.form,
      articleSubjectId: articleFields.articleSubjectId,
      relatedSubjectIds: articleFields.relatedSubjectIds,
      sourceFiles: articleFields.sourceFiles,
      checkedAgainstCommit: articleFields.checkedAgainstCommit,
      replacementSlug,
      author: input.author,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      at: now,
    })
    const names = new Map(
      articleFields.subjectRows.map((row: Record<string, unknown>) => [
        String(row.id),
        String(row.name),
      ]),
    )
    return { id: docId, revisionId, ...hostedArticleResponse(articleFields, names) }
  })
}

type CanonImportRow = RecordCanonImportInput['rows'][number]
type StoredCanonRow = Record<string, unknown>

function indexCanonBatch(input: Tenant & RecordCanonImportInput, currentRows: StoredCanonRow[]) {
  const desired = new Map<string, CanonImportRow>()
  for (const row of input.rows) {
    if (desired.has(row.slug)) throw new RecordDocError(`duplicate canon slug: ${row.slug}`)
    desired.set(row.slug, row)
  }
  const existing = new Map<string, StoredCanonRow>(
    currentRows.map((row) => [String(row.slug), row]),
  )
  for (const row of currentRows) {
    assertRevisionWrite({
      expectedRevision: input.expectedRevisions[String(row.slug)],
      current: row.latest_revision_id,
      isCreate: false,
      scope: 'canon',
    })
  }
  for (const slug of Object.keys(input.expectedRevisions)) {
    if (!existing.has(slug)) {
      throw new RecordDocError(`refusing stale canon import: no current row for ${slug}`, 409)
    }
  }
  return { desired, existing }
}

async function writeCanonRows(
  tx: SQL,
  input: Tenant & RecordCanonImportInput,
  existing: Map<string, StoredCanonRow>,
  address: { subject: string | null; owner: string | null; projectId: string | null },
  at: string,
): Promise<RecordCanonImportResult['rows']> {
  const results: RecordCanonImportResult['rows'] = []
  for (const row of input.rows) {
    const prior = existing.get(row.slug)
    const id = prior ? String(prior.id) : newRecordId()
    assertWrite(
      await recordCanonTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id,
        subject: address.subject,
        owner: address.owner,
        slug: row.slug,
        prior,
      }),
    )
    if (prior) {
      await tx`
        UPDATE doc SET title=${row.title}, body=${row.body}, delivery='demand',
          audiences=${bindRecordDocAudiences(tx, ['technical'])}, parent_id=NULL, position=0, updated_at=${at}::timestamptz
        WHERE space_id=${input.spaceId}::uuid AND id=${id}::uuid
      `
    } else {
      await tx`
        INSERT INTO doc (
          id, space_id, scope, subject, owner_user_id, slug, title, body, delivery, audiences, project_id, created_at, updated_at
        ) VALUES (
          ${id}::uuid, ${input.spaceId}::uuid, 'canon', ${address.subject}, ${address.owner}::uuid,
          ${row.slug}, ${row.title}, ${row.body}, 'demand', ${bindRecordDocAudiences(tx, ['technical'])}, ${address.projectId}::uuid,
          ${at}::timestamptz, ${at}::timestamptz
        )
      `
    }
    const revisionId = await insertRecordDocRevision(tx, {
      spaceId: input.spaceId,
      docId: id,
      scope: 'canon',
      subject: address.subject,
      owner: address.owner,
      slug: row.slug,
      projectId: address.projectId,
      op: 'import',
      title: row.title,
      body: row.body,
      delivery: 'demand',
      audiences: ['technical'],
      parentId: null,
      position: 0,
      status: prior?.status == null ? 'current' : (String(prior.status) as DocStatus),
      kind: prior?.kind == null ? 'working' : (String(prior.kind) as DocKind),
      replacementSlug: prior?.replacement_slug == null ? null : String(prior.replacement_slug),
      author: input.author,
      reason: input.reason,
      sessionId: null,
      at,
    })
    results.push({ slug: row.slug, id, revisionId })
  }
  return results
}

async function deleteMissingCanonRows(
  tx: SQL,
  input: Tenant & RecordCanonImportInput,
  currentRows: StoredCanonRow[],
  deletionSlugs: string[],
  address: { subject: string | null; owner: string | null; projectId: string | null },
  at: string,
): Promise<RecordCanonImportResult['deletions']> {
  const results: RecordCanonImportResult['deletions'] = []
  const deletedSlugs = new Set(deletionSlugs)
  for (const prior of currentRows) {
    const slug = String(prior.slug)
    if (!deletedSlugs.has(slug)) continue
    const id = String(prior.id)
    assertWrite(
      await recordCanonTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id,
        subject: address.subject,
        owner: address.owner,
        slug,
        prior,
        removing: true,
      }),
    )
    await tx`
      UPDATE doc SET deleted_at=${at}::timestamptz, updated_at=${at}::timestamptz
      WHERE space_id=${input.spaceId}::uuid AND id=${id}::uuid
    `
    const revisionId = await insertRecordDocRevision(tx, {
      spaceId: input.spaceId,
      docId: id,
      scope: 'canon',
      subject: address.subject,
      owner: address.owner,
      slug,
      projectId: address.projectId,
      op: 'delete',
      title: String(prior.title),
      body: String(prior.body),
      delivery: 'demand',
      audiences: ['technical'],
      parentId: null,
      position: 0,
      status: prior.status == null ? 'current' : (String(prior.status) as DocStatus),
      kind: prior.kind == null ? 'working' : (String(prior.kind) as DocKind),
      replacementSlug: prior.replacement_slug == null ? null : String(prior.replacement_slug),
      author: input.author,
      reason: input.reason,
      sessionId: null,
      at,
    })
    results.push({ slug, id, revisionId })
  }
  return results
}

export async function importRecordCanon(
  input: Tenant & RecordCanonImportInput,
): Promise<RecordCanonImportResult> {
  for (const row of input.rows) assertDocSections(row.body, ['technical'])
  return tenant(input, async (tx) => {
    const address =
      input.address.kind === 'user'
        ? { subject: null, owner: input.userId, projectId: null }
        : {
            subject: input.address.subject,
            owner: null,
            projectId: await hostedArticleProjectId(tx, input.spaceId, input.address.subject),
          }
    if (input.address.kind === 'user') {
      await tx`SELECT id FROM "user" WHERE id=${input.userId}::uuid FOR UPDATE`
    } else {
      await tx`SELECT id FROM project WHERE id=${address.projectId}::uuid FOR UPDATE`
    }
    const allRows = await tx`
      SELECT * FROM doc
      WHERE space_id=${input.spaceId}::uuid AND scope='canon'
        AND COALESCE(subject, '')=${address.subject ?? ''}
        AND COALESCE(owner_user_id::text, '')=${address.owner ?? ''}
        AND deleted_at IS NULL
      ORDER BY slug
      FOR UPDATE
    `
    const collision = nonCurrentCanonCollisionRefusal({
      rows: allRows.map((row: Record<string, unknown>) => ({
        slug: String(row.slug),
        status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
      })),
      desiredSlugs: input.rows.map((row) => row.slug),
      address: input.address,
    })
    if (collision) throw new RecordDocError(collision)
    const currentRows = allRows.filter(
      (row: Record<string, unknown>) =>
        (row.status == null ? 'current' : String(row.status)) === 'current',
    )
    const current: Array<{ slug: string; body: string }> = currentRows.map(
      (row: Record<string, unknown>) => ({
        slug: String(row.slug),
        body: String(row.body),
      }),
    )
    const history = await tx`
      SELECT id FROM doc_revision
      WHERE space_id=${input.spaceId}::uuid AND scope='canon'
        AND COALESCE(subject, '')=${address.subject ?? ''}
        AND COALESCE(owner_user_id::text, '')=${address.owner ?? ''}
      LIMIT 1
    `
    const plan = planCanonImport({
      address: { kind: input.address.kind },
      current,
      desired: input.rows.map(({ slug, body }) => ({ slug, body })),
      hasHistory: history.length > 0,
      surroundings: await recordCanonImportSurroundings(tx, {
        spaceId: input.spaceId,
        address: input.address,
      }),
    })
    if (plan.refusal === 'empty') throw new RecordDocError('refusing empty canon import')
    if (plan.refusal === 'findings') {
      throw new RecordDocError(canonFindingsRefusal(plan.findings)!)
    }

    const { existing } = indexCanonBatch(input, currentRows)
    const at = new Date().toISOString()
    const rows = await writeCanonRows(tx, input, existing, address, at)
    const deletions = await deleteMissingCanonRows(
      tx,
      input,
      currentRows,
      plan.deletionSlugs,
      address,
      at,
    )
    return { rows, deletions, findings: plan.findings, bootstrap: plan.bootstrap }
  })
}

export async function deleteRecordDoc(
  input: Tenant & {
    id: string
    reason: string
    author: string
    sessionId?: string | null
    expectedRevision?: string
    generator?: DocGenerator
  },
): Promise<{ id: string; revisionId: string }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT * FROM doc WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid FOR UPDATE
    `
    if (!rows[0]) throw new RecordDocError('doc not found', 404)
    const doc = rows[0] as Record<string, unknown>
    assertHostedReferenceUpsertAllowed(doc, input)
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: doc.latest_revision_id,
      isCreate: false,
      scope: String(doc.scope),
    })
    if (rows.length !== 1)
      throw new RecordDocError('refusing to delete more than one document', 409)
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id: input.id,
        slug: String(doc.slug),
        scope: String(doc.scope),
        subject: doc.subject == null ? null : String(doc.subject),
        owner: doc.owner_user_id == null ? null : String(doc.owner_user_id),
        audiences: recordDocAudiences(doc.audiences),
        parentId: doc.parent_id == null ? null : String(doc.parent_id),
        parentWasSpecified: false,
        removing: true,
      }),
    )
    const now = new Date().toISOString()
    const relatedSubjectIds = (
      await tx`SELECT subject_id FROM doc_related_subject WHERE space_id=${input.spaceId}::uuid AND doc_id=${input.id}::uuid`
    ).map((row: Record<string, unknown>) => String(row.subject_id))
    await tx`
      UPDATE doc SET deleted_at=${now}::timestamptz, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid AND deleted_at IS NULL
    `
    const revisionId = await insertRecordDocRevision(tx, {
      spaceId: input.spaceId,
      docId: input.id,
      scope: String(doc.scope),
      subject: doc.subject == null ? null : String(doc.subject),
      owner: doc.owner_user_id == null ? null : String(doc.owner_user_id),
      slug: String(doc.slug),
      projectId: doc.project_id == null ? null : String(doc.project_id),
      op: 'delete',
      title: String(doc.title),
      body: String(doc.body),
      delivery: String(doc.delivery) as DocDelivery,
      audiences: recordDocAudiences(doc.audiences),
      parentId: doc.parent_id == null ? null : String(doc.parent_id),
      position: Number(doc.position),
      status: (doc.status == null ? 'current' : String(doc.status)) as DocStatus,
      kind: (doc.kind == null ? 'working' : String(doc.kind)) as DocKind,
      form: doc.form == null ? null : (String(doc.form) as DocForm),
      articleSubjectId: doc.article_subject_id == null ? null : String(doc.article_subject_id),
      relatedSubjectIds,
      ...storedRevisionArticleFields(doc, input.id),
      replacementSlug: doc.replacement_slug == null ? null : String(doc.replacement_slug),
      author: input.author,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      at: now,
    })
    return { id: input.id, revisionId }
  })
}

export async function consumeRecordDoc(
  input: Tenant & {
    id: string
    reason: string
    author: string
    sessionId?: string | null
    expectedRevision?: string
  },
): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT * FROM doc
      WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `
    if (!rows[0]) throw new RecordDocError('doc not found', 404)
    const doc = rows[0] as Record<string, unknown>
    assertHostedStoredReferenceWriteAllowed(doc)
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: doc.latest_revision_id,
      isCreate: false,
      scope: String(doc.scope),
    })
    const now = new Date().toISOString()
    const relatedSubjectIds = (
      await tx`SELECT subject_id FROM doc_related_subject WHERE space_id=${input.spaceId}::uuid AND doc_id=${input.id}::uuid`
    ).map((row: Record<string, unknown>) => String(row.subject_id))
    const consumed = consumeDocBody(String(doc.body), now, input.sessionId ?? input.author)
    if (consumed.alreadyConsumed) return { id: input.id, revisionId: '', alreadyConsumed: true }
    assertDocSections(consumed.body, recordDocAudiences(doc.audiences))
    await tx`
      UPDATE doc SET body=${consumed.body}, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
    `
    const revisionId = await insertRecordDocRevision(tx, {
      spaceId: input.spaceId,
      docId: input.id,
      scope: String(doc.scope),
      subject: doc.subject == null ? null : String(doc.subject),
      owner: doc.owner_user_id == null ? null : String(doc.owner_user_id),
      slug: String(doc.slug),
      projectId: doc.project_id == null ? null : String(doc.project_id),
      op: 'consume',
      title: String(doc.title),
      body: consumed.body,
      delivery: String(doc.delivery) as DocDelivery,
      audiences: recordDocAudiences(doc.audiences),
      parentId: doc.parent_id == null ? null : String(doc.parent_id),
      position: Number(doc.position),
      status: (doc.status == null ? 'current' : String(doc.status)) as DocStatus,
      kind: (doc.kind == null ? 'working' : String(doc.kind)) as DocKind,
      form: doc.form == null ? null : (String(doc.form) as DocForm),
      articleSubjectId: doc.article_subject_id == null ? null : String(doc.article_subject_id),
      relatedSubjectIds,
      ...storedRevisionArticleFields(doc, input.id),
      replacementSlug: doc.replacement_slug == null ? null : String(doc.replacement_slug),
      author: input.author,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      at: now,
    })
    return { id: input.id, revisionId, alreadyConsumed: false }
  })
}

export async function restoreRecordDoc(
  input: Tenant & {
    id: string
    revisionId: string
    reason: string
    author: string
    sessionId?: string | null
    expectedRevision?: string
  },
): Promise<{ id: string; revisionId: string }> {
  return tenant(input, async (tx) => {
    const existing = await tx`
      SELECT * FROM doc
      WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid
      FOR UPDATE
    `
    const live = storedReferenceWriteRow(existing[0])
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: live.latest_revision_id,
      isCreate: false,
      scope: String(live.scope),
    })
    const revisionRows = await tx`
      SELECT * FROM doc_revision
      WHERE space_id=${input.spaceId}::uuid AND id=${input.revisionId}::uuid AND doc_id=${input.id}::uuid
    `
    if (!revisionRows[0]) throw new RecordDocError('revision not found', 404)
    const revision = revisionRows[0] as StoredDocRow
    const scope = String(live.scope)
    const subject = live.subject == null ? null : String(live.subject)
    const owner = live.owner_user_id == null ? null : String(live.owner_user_id)
    const slug = String(live.slug)
    assertWrite(
      recordDocRevisionIdentityRefusal(
        { scope, subject, owner, slug },
        {
          scope: String(revision.scope),
          subject: revision.subject == null ? null : String(revision.subject),
          owner: revision.owner_user_id == null ? null : String(revision.owner_user_id),
          slug: String(revision.slug),
        },
        'restore',
      ),
    )
    const revisionProjectId = revision.project_id == null ? null : String(revision.project_id)
    let resolvedProjectId: string | null = null
    try {
      resolvedProjectId = await hostedArticleProjectId(
        tx,
        input.spaceId,
        docWriteProjectName(scope, subject),
      )
    } catch (error) {
      if (!(error instanceof RecordDocError) || error.status !== 422) throw error
    }
    const body = String(revision.body)
    const delivery = String(revision.delivery) as DocDelivery
    const audiences = recordDocAudiences(revision.audiences)
    assertDocSections(body, audiences)
    const parentId = revision.parent_id == null ? null : String(revision.parent_id)
    const position = Number(revision.position)
    const featured = revision.featured == null ? false : Boolean(revision.featured)
    const status = (revision.status == null ? 'current' : String(revision.status)) as DocStatus
    const kind = (revision.kind == null ? 'working' : String(revision.kind)) as DocKind
    const { form, articleSubjectId, relatedSubjectIds, sourceFiles, checkedAgainstCommit } =
      restoredArticleFields(revision)
    const replacementSlug =
      revision.replacement_slug == null ? null : String(revision.replacement_slug)
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id: input.id,
        scope,
        subject,
        owner,
        slug,
        audiences,
        parentId,
        parentWasSpecified: true,
      }),
    )
    const facts = await canonFacts(tx, input.spaceId, scope, subject, slug, body, owner)
    assertWrite(facts.canonRefusal)
    assertWrite(
      refuseDocWrite({
        scope,
        subject,
        slug,
        body,
        delivery,
        packBytes: 0,
        ...facts,
      }),
    )
    const now = new Date().toISOString()
    await tx`
      UPDATE doc
      SET title=${String(revision.title)}, body=${body}, delivery=${delivery},
          audiences=${bindRecordDocAudiences(tx, audiences)}, featured=${featured}, status=${status}, kind=${kind}, form=${form}, article_subject_id=${articleSubjectId}::uuid, source_files=${bindJsonb(tx, sourceFiles)}, checked_against_commit=${checkedAgainstCommit}, replacement_slug=${replacementSlug}, parent_id=${parentId}::uuid, position=${position},
          project_id=COALESCE(${resolvedProjectId}::uuid, project_id),
          deleted_at=NULL, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
    `
    await replaceHostedRelatedSubjects(tx, input.spaceId, input.id, relatedSubjectIds)
    const revisionId = await insertRecordDocRevision(tx, {
      spaceId: input.spaceId,
      docId: input.id,
      scope,
      subject,
      owner,
      slug,
      projectId: resolvedProjectId ?? revisionProjectId,
      op: 'restore',
      title: String(revision.title),
      body,
      delivery,
      audiences,
      parentId,
      position,
      featured,
      status,
      kind,
      form,
      articleSubjectId,
      relatedSubjectIds,
      sourceFiles,
      checkedAgainstCommit,
      replacementSlug,
      author: input.author,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      at: now,
    })
    return { id: input.id, revisionId }
  })
}

export async function renameRecordDocSubject(
  input: Tenant & { from: string; to: string; count: number },
): Promise<{ docs: number; revisions: number }> {
  return tenant(input, async (tx) => {
    const docs = await tx`
      SELECT count(*)::integer AS n FROM doc
      WHERE space_id=${input.spaceId}::uuid AND subject=${input.from}
    `
    const revisions = await tx`
      SELECT count(*)::integer AS n FROM doc_revision
      WHERE space_id=${input.spaceId}::uuid AND subject=${input.from}
    `
    const docCount = Number(docs[0]?.n ?? 0)
    const revisionCount = Number(revisions[0]?.n ?? 0)
    if (docCount + revisionCount !== input.count) {
      throw new RecordDocError(
        `refusing subject rename: hosted count ${docCount + revisionCount} does not match stated ${input.count}`,
        409,
      )
    }
    if (docCount) {
      await tx`
        UPDATE doc SET subject=${input.to}, updated_at=now()
        WHERE space_id=${input.spaceId}::uuid AND subject=${input.from}
      `
    }
    if (revisionCount) {
      await tx`
        UPDATE doc_revision SET subject=${input.to}
        WHERE space_id=${input.spaceId}::uuid AND subject=${input.from}
      `
    }
    return { docs: docCount, revisions: revisionCount }
  })
}

export async function countRecordDocs(input: Tenant): Promise<{ docs: number; revisions: number }> {
  return tenant(input, async (tx) => {
    const docs =
      await tx`SELECT count(*)::integer AS n FROM doc WHERE space_id=${input.spaceId}::uuid`
    const revisions =
      await tx`SELECT count(*)::integer AS n FROM doc_revision WHERE space_id=${input.spaceId}::uuid`
    return { docs: Number(docs[0]?.n ?? 0), revisions: Number(revisions[0]?.n ?? 0) }
  })
}

function assertImportedRevisions(
  doc: ReturnType<typeof normalizeRecordDocImport>['doc'],
  revisions: ReturnType<typeof normalizeRecordDocImport>['revisions'],
): void {
  for (const revision of revisions) {
    assertWrite(recordDocRevisionIdentityRefusal(doc, revision, 'import'))
    assertDocSections(revision.body, recordDocAudiences(revision.audiences))
  }
  assertDocSections(doc.body, recordDocAudiences(doc.audiences))
}

function storedReferenceWriteRow(row: Record<string, unknown> | undefined): StoredDocRow {
  if (!row) throw new RecordDocError('doc not found', 404)
  assertHostedStoredReferenceWriteAllowed(row)
  return row as StoredDocRow
}

async function referenceImportExisting(
  tx: SQL,
  spaceId: string,
  doc: ReturnType<typeof normalizeRecordDocImport>['doc'],
): Promise<Record<string, unknown> | undefined> {
  const existing = await existingDocAtAddress(tx, spaceId, doc)
  assertHostedReferenceImportAllowed(existing, doc.form)
  return existing
}

export async function importRecordDoc(
  input: Tenant & RecordDocImportInput,
): Promise<{ id: string; revisionIds: string[] } & HostedArticleResponse> {
  const { doc: importedDoc, revisions } = normalizeRecordDocImport(input, newRecordId())
  const ownedAddress =
    refuseOwnedDocAddress(importedDoc.scope, importedDoc.subject, importedDoc.owner) ??
    refuseSettingsAddress(importedDoc.scope, importedDoc.subject, importedDoc.owner)
  if (ownedAddress) throw new RecordDocError(ownedAddress)
  assertWrite(
    refuseMismatchedDocProject(importedDoc.scope, importedDoc.subject, importedDoc.projectName),
  )
  assertImportedRevisions(importedDoc, revisions)
  return tenant(input, async (tx) => {
    const existing = await referenceImportExisting(tx, input.spaceId, importedDoc)
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: existing?.latest_revision_id,
      isCreate: !existing,
      scope: importedDoc.scope,
    })
    if (existing && importedDoc.deletedAt !== null && existing.deleted_at == null) {
      const subject = existing.subject == null ? '' : String(existing.subject)
      throw new RecordDocError(
        `refusing import at ${String(existing.scope)}/${subject}/${String(existing.slug)}: a deleted import never targets a live row; delete the live doc through the doc service first if deletion is intended`,
        409,
      )
    }
    const newerHosted = newerHostedImportRefusal(existing, importedDoc)
    if (newerHosted) throw new RecordDocError(newerHosted, 409)
    const existingRelated = existing
      ? await tx`SELECT subject_id FROM doc_related_subject WHERE space_id=${input.spaceId}::uuid AND doc_id=${String(existing.id)}::uuid`
      : []
    const doc = {
      ...importedDoc,
      ...importedLiveArticleFields(
        importedDoc,
        existing,
        existingRelated.map((row: Record<string, unknown>) => String(row.subject_id)),
      ),
    }
    assertWrite(
      recordDocLintRefusal(
        doc,
        existing
          ? {
              scope: String(existing.scope),
              subject: existing.subject == null ? null : String(existing.subject),
              slug: String(existing.slug),
              body: String(existing.body),
              kind: (existing.kind == null ? 'working' : String(existing.kind)) as DocKind,
            }
          : undefined,
      ),
    )
    const resolvedProject = await resolvedDocProjectId(tx, input.spaceId, doc)
    const importedSubjectNames = await importedArticleSubjectNames(
      tx,
      { spaceId: input.spaceId, subject: doc.subject },
      resolvedProject,
      doc,
      revisions,
    )
    const id = existing ? String(existing.id) : doc.id
    await validateImportedDocumentLifecycles(tx, { ...doc, spaceId: input.spaceId }, [
      { status: doc.status, replacementSlug: doc.replacementSlug },
      ...revisions.map(({ status, replacementSlug }) => ({ status, replacementSlug })),
    ])
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id,
        scope: doc.scope,
        subject: doc.subject,
        owner: doc.owner ?? null,
        slug: doc.slug,
        audiences: recordDocAudiences(doc.audiences),
        parentId: doc.parentId,
        parentWasSpecified: true,
        removing: doc.deletedAt !== null,
      }),
    )
    await writeImportedRecordDoc(tx, {
      spaceId: input.spaceId,
      id,
      exists: Boolean(existing),
      projectId: resolvedProject,
      doc,
    })
    const revisionIds: string[] = []
    for (const revision of revisions) {
      revisionIds.push(
        await insertRecordDocRevision(tx, {
          spaceId: input.spaceId,
          docId: id,
          scope: doc.scope,
          subject: doc.subject,
          owner: doc.owner ?? null,
          slug: doc.slug,
          projectId: resolvedProject,
          op: revision.op,
          title: revision.title,
          body: revision.body,
          delivery: revision.delivery,
          audiences: recordDocAudiences(revision.audiences),
          parentId: revision.parentId,
          position: revision.position,
          featured: revision.featured,
          status: revision.status,
          kind: revision.kind,
          form: revision.form,
          articleSubjectId: revision.articleSubjectId,
          relatedSubjectIds: revision.relatedSubjectIds,
          sourceFiles: revision.sourceFiles,
          checkedAgainstCommit: revision.checkedAgainstCommit,
          replacementSlug: revision.replacementSlug,
          author: revision.author,
          reason: revision.reason,
          sessionId: revision.sessionId ?? null,
          at: revision.at,
        }),
      )
    }
    return { id, revisionIds, ...hostedArticleResponse(doc, importedSubjectNames) }
  })
}
