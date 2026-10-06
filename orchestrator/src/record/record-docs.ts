// concern: record-docs
/** Owns tenant-bound hosted document reads and writes. Must not know local cache, CLI, or HTTP. */
import { SQL } from 'bun'
import { DOC_AUDIENCES, type DocAudience } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { planCanonImport } from '../canon/canon-import-policy.ts'
import type { CanonFinding } from '../canon/canon-lint.ts'
import {
  canonFindingsRefusal,
  consumeDocBody,
  type DocDelivery,
  type DocRevisionOp,
  decideDocRevisionWrite,
  docWriteProjectName,
  recordDocLintRefusal,
  refuseDocWrite,
  refuseOwnedDocAddress,
  refuseSettingsAddress,
} from '../doc/doc-write-allowed.ts'
import { canonFacts, recordCanonImportSurroundings } from './record-canon-facts.ts'
import {
  type NormalizedRecordDocImport,
  newerHostedImportRefusal,
  normalizeRecordDocImport,
  type RecordDoc,
  type RecordDocImportInput,
  type RecordDocRevision,
  recordDocRevisionIdentityRefusal,
  recordDocRevisionRow,
  recordDocRow,
} from './record-doc-mapping.ts'
import {
  existingDocAtAddress,
  recordCanonTreeWriteRefusal,
  recordTreeWriteRefusal,
} from './record-doc-tree.ts'

export type { RecordDoc, RecordDocImportInput, RecordDocRevision } from './record-doc-mapping.ts'

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

export class RecordDocError extends Error {
  status: 400 | 404 | 409 | 422
  constructor(message: string, status: 400 | 404 | 409 | 422 = 400) {
    super(message)
    this.status = status
  }
}

type Tenant = { url: string } & TenantPrincipal
type RecordCursor = { at: string; id: string }

export type RecordDocListInput = {
  scope?: string
  subject?: string | null
  audience?: DocAudience
  updatedSince?: string
  limit: number
  cursor: RecordCursor | null
  includeDeleted: boolean
  acrossReadableSpaces: boolean
}

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

async function projectId(
  tx: SQL,
  spaceId: string,
  name: string | null | undefined,
): Promise<string | null> {
  if (!name) return null
  const rows = await tx`SELECT id FROM project WHERE space_id=${spaceId}::uuid AND name=${name}`
  if (rows.length !== 1) throw new RecordDocError(`record project is absent: ${name}`, 422)
  return String(rows[0]!.id)
}

function assertWrite(refusal: string | null): void {
  if (refusal) throw new RecordDocError(refusal)
}

function assertRevisionWrite(input: {
  expectedRevision?: string
  current: unknown
  isCreate: boolean
  scope: string
}): void {
  const decision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current: input.current == null ? null : String(input.current),
    isCreate: input.isCreate,
    scope: input.scope,
  })
  if (!decision.allow) throw new RecordDocError(decision.reason, 409)
}

export async function listRecordDocs(input: Tenant & RecordDocListInput): Promise<RecordDoc[]> {
  return tenant(input, async (tx) => {
    const spaceIds = input.spaceIds?.length ? input.spaceIds : [input.spaceId]
    const selectedSpaceIds = input.acrossReadableSpaces ? spaceIds : [input.spaceId]
    const rows = await tx`
      SELECT d.*, s.name AS space_name, p.name AS project_name
      FROM doc d
      JOIN space s ON s.id=d.space_id
      LEFT JOIN project p ON p.id=d.project_id
      WHERE d.space_id = ANY(string_to_array(${selectedSpaceIds.join(',')}, ',')::uuid[])
        AND (${input.scope ?? null}::text IS NULL OR d.scope=${input.scope ?? null})
        AND (${input.audience ?? null}::text IS NULL OR d.audience=${input.audience ?? null})
        AND (
          ${input.subject === undefined}::boolean
          OR (${input.subject === null}::boolean AND d.subject IS NULL)
          OR d.subject=${input.subject ?? null}
        )
        AND (${input.includeDeleted}::boolean OR d.deleted_at IS NULL)
        AND (
          ${input.updatedSince ?? null}::timestamptz IS NULL
          OR d.updated_at > ${input.updatedSince ?? null}::timestamptz
        )
        AND (
          ${input.cursor?.at ?? null}::timestamptz IS NULL
          OR (d.updated_at, d.id) > (${input.cursor?.at ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid)
        )
      ORDER BY d.updated_at, d.id
      LIMIT ${input.limit + 1}
    `
    return rows.map((row: Record<string, unknown>) => recordDocRow(row))
  })
}

export async function getRecordDoc(input: Tenant & { id: string }): Promise<RecordDoc | null> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT d.*, s.name AS space_name, p.name AS project_name
      FROM doc d
      JOIN space s ON s.id=d.space_id
      LEFT JOIN project p ON p.id=d.project_id
      WHERE d.id=${input.id}::uuid
    `
    return rows[0] ? recordDocRow(rows[0] as Record<string, unknown>) : null
  })
}

export async function listRecordDocRevisions(
  input: Tenant & { id: string },
): Promise<RecordDocRevision[] | null> {
  return tenant(input, async (tx) => {
    const docs = await tx`SELECT id,space_id FROM doc WHERE id=${input.id}::uuid`
    if (!docs.length) return null
    const rows = await tx`
      SELECT * FROM doc_revision
      WHERE space_id=${String(docs[0]!.space_id)}::uuid AND doc_id=${input.id}::uuid
      ORDER BY at DESC, id DESC
    `
    return rows.map((row: Record<string, unknown>) => recordDocRevisionRow(row))
  })
}

export async function upsertRecordDoc(
  input: Tenant & {
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    title: string
    body: string
    delivery: DocDelivery
    audience?: DocAudience
    parentRecordId?: string | null
    position?: number
    projectName?: string | null
    reason: string
    author: string
    sessionId?: string | null
    forceInject?: string
    op?: DocRevisionOp
    at?: string
    id?: string
    revisionId?: string
    expectedRevision?: string
  },
): Promise<{ id: string; revisionId: string }> {
  const ownedAddress =
    refuseOwnedDocAddress(input.scope, input.subject, input.owner) ??
    refuseSettingsAddress(input.scope, input.subject, input.owner)
  if (ownedAddress) throw new RecordDocError(ownedAddress)
  return tenant(input, async (tx) => {
    const existing = await tx`
      SELECT id, scope, subject, owner_user_id, slug, body, audience, parent_id, position, latest_revision_id FROM doc
      WHERE space_id=${input.spaceId}::uuid
        AND scope=${input.scope}
        AND COALESCE(subject, '')=${input.subject ?? ''}
        AND COALESCE(owner_user_id::text, '')=${input.owner ?? ''}
        AND slug=${input.slug}
        AND deleted_at IS NULL
      FOR UPDATE
    `
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
    assertWrite(
      refuseDocWrite({
        scope: input.scope,
        subject: input.subject,
        slug: input.slug,
        body: input.body,
        delivery: input.delivery,
        forceInject: input.forceInject,
        packBytes: 0,
        ...facts,
      }),
    )
    assertWrite(
      recordDocLintRefusal(
        input,
        existing[0]
          ? {
              scope: String(existing[0].scope),
              subject: existing[0].subject == null ? null : String(existing[0].subject),
              slug: String(existing[0].slug),
              body: String(existing[0].body),
            }
          : undefined,
      ),
    )
    const resolvedProject = await projectId(
      tx,
      input.spaceId,
      input.projectName ?? docWriteProjectName(input.scope, input.subject),
    )
    const now = input.at ?? new Date().toISOString()
    const docId = existing[0] ? String(existing[0].id) : (input.id ?? newRecordId())
    const audience =
      input.audience ??
      ((existing[0]?.audience == null ? 'technical' : String(existing[0].audience)) as DocAudience)
    if (!DOC_AUDIENCES.includes(audience))
      throw new RecordDocError(
        `unknown doc audience "${audience}"; valid audiences: ${DOC_AUDIENCES.join(', ')}`,
      )
    const parentId =
      input.parentRecordId === undefined
        ? existing[0]?.parent_id == null
          ? null
          : String(existing[0].parent_id)
        : input.parentRecordId
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id: docId,
        slug: input.slug,
        scope: input.scope,
        subject: input.subject,
        owner: input.owner ?? null,
        audience,
        priorAudience:
          existing[0]?.audience == null ? undefined : (String(existing[0].audience) as DocAudience),
        parentId,
        parentWasSpecified: input.parentRecordId !== undefined,
      }),
    )
    const position =
      input.position ?? (existing[0]?.position == null ? 0 : Number(existing[0].position))
    const op: DocRevisionOp = input.op ?? (existing[0] ? 'set' : 'create')
    if (existing[0]) {
      await tx`
        UPDATE doc
        SET title=${input.title}, body=${input.body}, delivery=${input.delivery},
            audience=${audience}, parent_id=${parentId}::uuid, position=${position},
            owner_user_id=${input.owner ?? null}::uuid,
            project_id=${resolvedProject}::uuid, updated_at=${now}::timestamptz
        WHERE id=${docId}::uuid AND space_id=${input.spaceId}::uuid
      `
    } else {
      await tx`
        INSERT INTO doc (
          id, space_id, scope, subject, owner_user_id, slug, title, body, delivery, audience, parent_id, position, project_id, created_at, updated_at
        ) VALUES (
          ${docId}::uuid, ${input.spaceId}::uuid, ${input.scope}, ${input.subject}, ${input.owner ?? null}::uuid, ${input.slug},
          ${input.title}, ${input.body}, ${input.delivery}, ${audience}, ${parentId}::uuid, ${position}, ${resolvedProject}::uuid,
          ${now}::timestamptz, ${now}::timestamptz
        )
      `
    }
    const revisionId = await insertRevision(tx, {
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
      delivery: input.delivery,
      audience,
      parentId,
      position,
      author: input.author,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      at: now,
    })
    return { id: docId, revisionId }
  })
}

async function insertRevision(
  tx: SQL,
  input: {
    id?: string
    spaceId: string
    docId: string
    scope: string
    subject: string | null
    owner: string | null
    slug: string
    projectId: string | null
    op: DocRevisionOp
    title: string
    body: string
    delivery: DocDelivery
    audience: DocAudience
    parentId: string | null
    position: number
    author: string
    reason: string
    sessionId: string | null
    at: string
  },
): Promise<string> {
  const id = input.id ?? newRecordId()
  const existing = input.id
    ? await tx`SELECT id FROM doc_revision WHERE space_id=${input.spaceId}::uuid AND id=${id}::uuid`
    : await tx`
        SELECT id FROM doc_revision
        WHERE space_id=${input.spaceId}::uuid AND doc_id=${input.docId}::uuid
          AND at=${input.at}::timestamptz AND op=${input.op}
          AND author=${input.author} AND reason=${input.reason}
      `
  const storedId = existing[0] ? String(existing[0].id) : id
  if (!existing[0]) {
    await tx`
      INSERT INTO doc_revision (
        id, space_id, doc_id, scope, subject, owner_user_id, slug, project_id, op, title, body, delivery, audience, parent_id, position,
        author, reason, session_id, at
      ) VALUES (
        ${id}::uuid, ${input.spaceId}::uuid, ${input.docId}::uuid, ${input.scope}, ${input.subject}, ${input.owner}::uuid,
        ${input.slug}, ${input.projectId}::uuid, ${input.op}, ${input.title}, ${input.body},
        ${input.delivery}, ${input.audience}, ${input.parentId}::uuid, ${input.position}, ${input.author}, ${input.reason}, ${input.sessionId}, ${input.at}::timestamptz
      )
    `
  }
  await tx`
    UPDATE doc SET latest_revision_id=${storedId}::uuid
    WHERE space_id=${input.spaceId}::uuid AND id=${input.docId}::uuid
  `
  return storedId
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
          audience='technical', parent_id=NULL, position=0, updated_at=${at}::timestamptz
        WHERE space_id=${input.spaceId}::uuid AND id=${id}::uuid
      `
    } else {
      await tx`
        INSERT INTO doc (
          id, space_id, scope, subject, owner_user_id, slug, title, body, delivery, project_id, created_at, updated_at
        ) VALUES (
          ${id}::uuid, ${input.spaceId}::uuid, 'canon', ${address.subject}, ${address.owner}::uuid,
          ${row.slug}, ${row.title}, ${row.body}, 'demand', ${address.projectId}::uuid,
          ${at}::timestamptz, ${at}::timestamptz
        )
      `
    }
    const revisionId = await insertRevision(tx, {
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
      audience: 'technical',
      parentId: null,
      position: 0,
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
    const revisionId = await insertRevision(tx, {
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
      audience: 'technical',
      parentId: null,
      position: 0,
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
  return tenant(input, async (tx) => {
    const address =
      input.address.kind === 'user'
        ? { subject: null, owner: input.userId, projectId: null }
        : {
            subject: input.address.subject,
            owner: null,
            projectId: await projectId(tx, input.spaceId, input.address.subject),
          }
    if (input.address.kind === 'user') {
      await tx`SELECT id FROM "user" WHERE id=${input.userId}::uuid FOR UPDATE`
    } else {
      await tx`SELECT id FROM project WHERE id=${address.projectId}::uuid FOR UPDATE`
    }
    const currentRows = await tx`
      SELECT * FROM doc
      WHERE space_id=${input.spaceId}::uuid AND scope='canon'
        AND COALESCE(subject, '')=${address.subject ?? ''}
        AND COALESCE(owner_user_id::text, '')=${address.owner ?? ''}
        AND deleted_at IS NULL
      ORDER BY slug
      FOR UPDATE
    `
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
  },
): Promise<{ id: string; revisionId: string }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT * FROM doc WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid FOR UPDATE
    `
    if (!rows[0]) throw new RecordDocError('doc not found', 404)
    const doc = rows[0] as Record<string, unknown>
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
        audience: String(doc.audience) as DocAudience,
        parentId: doc.parent_id == null ? null : String(doc.parent_id),
        parentWasSpecified: false,
        removing: true,
      }),
    )
    const now = new Date().toISOString()
    await tx`
      UPDATE doc SET deleted_at=${now}::timestamptz, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid AND deleted_at IS NULL
    `
    const revisionId = await insertRevision(tx, {
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
      audience: String(doc.audience) as DocAudience,
      parentId: doc.parent_id == null ? null : String(doc.parent_id),
      position: Number(doc.position),
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
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: doc.latest_revision_id,
      isCreate: false,
      scope: String(doc.scope),
    })
    const now = new Date().toISOString()
    const consumed = consumeDocBody(String(doc.body), now, input.sessionId ?? input.author)
    if (consumed.alreadyConsumed) return { id: input.id, revisionId: '', alreadyConsumed: true }
    await tx`
      UPDATE doc SET body=${consumed.body}, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
    `
    const revisionId = await insertRevision(tx, {
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
      audience: String(doc.audience) as DocAudience,
      parentId: doc.parent_id == null ? null : String(doc.parent_id),
      position: Number(doc.position),
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
    if (!existing[0]) throw new RecordDocError('doc not found', 404)
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: existing[0].latest_revision_id,
      isCreate: false,
      scope: String(existing[0].scope),
    })
    const revisionRows = await tx`
      SELECT * FROM doc_revision
      WHERE space_id=${input.spaceId}::uuid AND id=${input.revisionId}::uuid AND doc_id=${input.id}::uuid
    `
    if (!revisionRows[0]) throw new RecordDocError('revision not found', 404)
    const revision = revisionRows[0] as Record<string, unknown>
    const live = existing[0] as Record<string, unknown>
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
    // An unresolved project leaves the live document's project as it is.
    let resolvedProjectId: string | null = null
    try {
      resolvedProjectId = await projectId(tx, input.spaceId, docWriteProjectName(scope, subject))
    } catch (error) {
      if (!(error instanceof RecordDocError) || error.status !== 422) throw error
    }
    const body = String(revision.body)
    const delivery = String(revision.delivery) as DocDelivery
    const audience = String(revision.audience) as DocAudience
    const parentId = revision.parent_id == null ? null : String(revision.parent_id)
    const position = Number(revision.position)
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id: input.id,
        scope,
        subject,
        owner,
        slug,
        audience,
        priorAudience: String(existing[0].audience) as DocAudience,
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
          audience=${audience}, parent_id=${parentId}::uuid, position=${position},
          project_id=COALESCE(${resolvedProjectId}::uuid, project_id),
          deleted_at=NULL, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
    `
    const revisionId = await insertRevision(tx, {
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
      audience,
      parentId,
      position,
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

async function writeImportedDoc(
  tx: SQL,
  input: {
    spaceId: string
    id: string
    exists: boolean
    projectId: string | null
    doc: NormalizedRecordDocImport['doc']
  },
): Promise<void> {
  const { doc, spaceId, id, projectId } = input
  if (input.exists) {
    await tx`
      UPDATE doc
      SET title=${doc.title}, body=${doc.body}, delivery=${doc.delivery},
          audience=${doc.audience}, parent_id=${doc.parentId}::uuid, position=${doc.position},
          owner_user_id=${doc.owner ?? null}::uuid, project_id=${projectId}::uuid,
          created_at=${doc.createdAt}::timestamptz,
          updated_at=${doc.updatedAt}::timestamptz,
          deleted_at=${doc.deletedAt}::timestamptz
      WHERE id=${id}::uuid AND space_id=${spaceId}::uuid
    `
    return
  }
  await tx`
    INSERT INTO doc (
      id, space_id, scope, subject, owner_user_id, slug, title, body, delivery, audience, parent_id, position, project_id,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${id}::uuid, ${spaceId}::uuid, ${doc.scope}, ${doc.subject}, ${doc.owner ?? null}::uuid, ${doc.slug},
      ${doc.title}, ${doc.body}, ${doc.delivery}, ${doc.audience}, ${doc.parentId}::uuid, ${doc.position}, ${projectId}::uuid,
      ${doc.createdAt}::timestamptz, ${doc.updatedAt}::timestamptz, ${doc.deletedAt}::timestamptz
    )
  `
}

export async function importRecordDoc(
  input: Tenant & RecordDocImportInput,
): Promise<{ id: string; revisionIds: string[] }> {
  const { doc, revisions } = normalizeRecordDocImport(input, newRecordId())
  const ownedAddress =
    refuseOwnedDocAddress(doc.scope, doc.subject, doc.owner) ??
    refuseSettingsAddress(doc.scope, doc.subject, doc.owner)
  if (ownedAddress) throw new RecordDocError(ownedAddress)
  for (const revision of revisions) {
    assertWrite(recordDocRevisionIdentityRefusal(doc, revision, 'import'))
  }
  return tenant(input, async (tx) => {
    const existing = await existingDocAtAddress(tx, input.spaceId, doc)
    assertRevisionWrite({
      expectedRevision: input.expectedRevision,
      current: existing?.latest_revision_id,
      isCreate: !existing,
      scope: doc.scope,
    })
    if (existing && doc.deletedAt !== null && existing.deleted_at == null) {
      const subject = existing.subject == null ? '' : String(existing.subject)
      throw new RecordDocError(
        `refusing import at ${String(existing.scope)}/${subject}/${String(existing.slug)}: a deleted import never targets a live row; delete the live doc through the doc service first if deletion is intended`,
        409,
      )
    }
    const newerHosted = newerHostedImportRefusal(existing, doc)
    if (newerHosted) throw new RecordDocError(newerHosted, 409)
    assertWrite(
      recordDocLintRefusal(
        doc,
        existing
          ? {
              scope: String(existing.scope),
              subject: existing.subject == null ? null : String(existing.subject),
              slug: String(existing.slug),
              body: String(existing.body),
            }
          : undefined,
      ),
    )
    const resolvedProject = await projectId(tx, input.spaceId, doc.projectName)
    const id = existing ? String(existing.id) : doc.id
    assertWrite(
      await recordTreeWriteRefusal(tx, {
        spaceId: input.spaceId,
        id,
        scope: doc.scope,
        subject: doc.subject,
        owner: doc.owner ?? null,
        slug: doc.slug,
        audience: doc.audience,
        priorAudience:
          existing?.audience == null ? undefined : (String(existing.audience) as DocAudience),
        parentId: doc.parentId,
        parentWasSpecified: true,
        removing: doc.deletedAt !== null,
      }),
    )
    await writeImportedDoc(tx, {
      spaceId: input.spaceId,
      id,
      exists: Boolean(existing),
      projectId: resolvedProject,
      doc,
    })
    const revisionIds: string[] = []
    for (const revision of revisions) {
      revisionIds.push(
        await insertRevision(tx, {
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
          audience: revision.audience,
          parentId: revision.parentId,
          position: revision.position,
          author: revision.author,
          reason: revision.reason,
          sessionId: revision.sessionId ?? null,
          at: revision.at,
        }),
      )
    }
    return { id, revisionIds }
  })
}
