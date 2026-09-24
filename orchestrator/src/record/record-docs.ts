// concern: record-docs
/** Owns tenant-bound hosted document reads and writes. Must not know local cache, CLI, or HTTP. */
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import {
  consumeDocBody,
  type DocDelivery,
  type DocRevisionOp,
  recordDocLintRefusal,
  refuseDocWrite,
} from '../doc/doc-write-allowed.ts'

export type RecordDoc = {
  id: string
  spaceId: string
  spaceName: string
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: DocDelivery
  projectName: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type RecordDocRevision = {
  id: string
  docId: string
  scope: string
  subject: string | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  delivery: DocDelivery
  author: string
  reason: string
  sessionId: string | null
  at: string
}

export type RecordDocImportInput = {
  doc: {
    scope: string
    subject: string | null
    slug: string
    title: string
    body: string
    delivery: DocDelivery
    projectName?: string | null
    createdAt: string
    updatedAt: string
    deletedAt: string | null
  }
  revisions: Array<{
    scope: string
    subject: string | null
    slug: string
    op: DocRevisionOp
    title: string
    body: string
    delivery: DocDelivery
    author: string
    reason: string
    sessionId?: string | null
    at: string
  }>
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

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

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

function docRow(row: Record<string, unknown>): RecordDoc {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    spaceName: String(row.space_name),
    scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    slug: String(row.slug),
    title: String(row.title),
    body: String(row.body),
    delivery: String(row.delivery) as DocDelivery,
    projectName: row.project_name == null ? null : String(row.project_name),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    deletedAt: iso(row.deleted_at),
  }
}

function revisionRow(row: Record<string, unknown>): RecordDocRevision {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    slug: String(row.slug),
    op: String(row.op) as DocRevisionOp,
    title: String(row.title),
    body: String(row.body),
    delivery: String(row.delivery) as DocDelivery,
    author: String(row.author),
    reason: String(row.reason),
    sessionId: row.session_id == null ? null : String(row.session_id),
    at: iso(row.at)!,
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

async function canonFacts(
  tx: SQL,
  spaceId: string,
  scope: string,
  subject: string | null,
  slug: string,
  body: string,
) {
  if (scope !== 'canon') {
    return {
      globalCanonSlugs: [] as string[],
      projectCanonSlugs: [] as string[],
      currentCanon: [] as { slug: string; body: string }[],
      nextCanon: [] as { slug: string; body: string }[],
    }
  }
  const global = await tx`
    SELECT slug, body FROM doc
    WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject IS NULL AND deleted_at IS NULL
  `
  const project = subject
    ? await tx`
        SELECT slug, body FROM doc
        WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject=${subject} AND deleted_at IS NULL
      `
    : []
  const asRows = (rows: Record<string, unknown>[]) =>
    rows.map((row) => ({ slug: String(row.slug), body: String(row.body) }))
  const globalRows = asRows(global)
  const projectRows = asRows(project)
  const replace = (rows: { slug: string; body: string }[]) => [
    ...rows.filter((row) => row.slug !== slug),
    { slug, body },
  ]
  return {
    globalCanonSlugs: globalRows.map((row) => row.slug),
    projectCanonSlugs: projectRows.map((row) => row.slug),
    currentCanon: subject ? projectRows : globalRows,
    nextCanon: subject ? replace(projectRows) : replace(globalRows),
  }
}

function assertWrite(refusal: string | null): void {
  if (refusal) throw new RecordDocError(refusal)
}

export async function listRecordDocs(
  input: Tenant & {
    scope?: string
    subject?: string | null
    updatedSince?: string
    limit: number
    cursor: RecordCursor | null
    includeDeleted: boolean
  },
): Promise<RecordDoc[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT d.*, s.name AS space_name, p.name AS project_name
      FROM doc d
      JOIN space s ON s.id=d.space_id
      LEFT JOIN project p ON p.id=d.project_id
      WHERE d.space_id=${input.spaceId}::uuid
        AND (${input.scope ?? null}::text IS NULL OR d.scope=${input.scope ?? null})
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
    return rows.map((row: Record<string, unknown>) => docRow(row))
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
    return rows[0] ? docRow(rows[0] as Record<string, unknown>) : null
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
    return rows.map((row: Record<string, unknown>) => revisionRow(row))
  })
}

export async function upsertRecordDoc(
  input: Tenant & {
    scope: string
    subject: string | null
    slug: string
    title: string
    body: string
    delivery: DocDelivery
    projectName?: string | null
    reason: string
    author: string
    sessionId?: string | null
    forceInject?: string
    op?: DocRevisionOp
    at?: string
    id?: string
    revisionId?: string
  },
): Promise<{ id: string; revisionId: string }> {
  return tenant(input, async (tx) => {
    const existing = await tx`
      SELECT id, scope, subject, slug, body FROM doc
      WHERE space_id=${input.spaceId}::uuid
        AND scope=${input.scope}
        AND COALESCE(subject, '')=${input.subject ?? ''}
        AND slug=${input.slug}
        AND deleted_at IS NULL
    `
    const facts = await canonFacts(
      tx,
      input.spaceId,
      input.scope,
      input.subject,
      input.slug,
      input.body,
    )
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
      input.projectName ??
        (input.scope === 'project' || (input.scope === 'canon' && input.subject)
          ? input.subject
          : null),
    )
    const now = input.at ?? new Date().toISOString()
    const docId = existing[0] ? String(existing[0].id) : (input.id ?? newRecordId())
    const op: DocRevisionOp = input.op ?? (existing[0] ? 'set' : 'create')
    if (existing[0]) {
      await tx`
        UPDATE doc
        SET title=${input.title}, body=${input.body}, delivery=${input.delivery},
            project_id=${resolvedProject}::uuid, updated_at=${now}::timestamptz
        WHERE id=${docId}::uuid AND space_id=${input.spaceId}::uuid
      `
    } else {
      await tx`
        INSERT INTO doc (
          id, space_id, scope, subject, slug, title, body, delivery, project_id, created_at, updated_at
        ) VALUES (
          ${docId}::uuid, ${input.spaceId}::uuid, ${input.scope}, ${input.subject}, ${input.slug},
          ${input.title}, ${input.body}, ${input.delivery}, ${resolvedProject}::uuid,
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
      slug: input.slug,
      projectId: resolvedProject,
      op,
      title: input.title,
      body: input.body,
      delivery: input.delivery,
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
    slug: string
    projectId: string | null
    op: DocRevisionOp
    title: string
    body: string
    delivery: DocDelivery
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
  if (existing[0]) return String(existing[0].id)
  await tx`
    INSERT INTO doc_revision (
      id, space_id, doc_id, scope, subject, slug, project_id, op, title, body, delivery,
      author, reason, session_id, at
    ) VALUES (
      ${id}::uuid, ${input.spaceId}::uuid, ${input.docId}::uuid, ${input.scope}, ${input.subject},
      ${input.slug}, ${input.projectId}::uuid, ${input.op}, ${input.title}, ${input.body},
      ${input.delivery}, ${input.author}, ${input.reason}, ${input.sessionId}, ${input.at}::timestamptz
    )
  `
  return id
}

export async function deleteRecordDoc(
  input: Tenant & { id: string; reason: string; author: string; sessionId?: string | null },
): Promise<{ id: string; revisionId: string }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT * FROM doc WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid
    `
    if (!rows[0]) throw new RecordDocError('doc not found', 404)
    const doc = rows[0] as Record<string, unknown>
    if (rows.length !== 1)
      throw new RecordDocError('refusing to delete more than one document', 409)
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
      slug: String(doc.slug),
      projectId: doc.project_id == null ? null : String(doc.project_id),
      op: 'delete',
      title: String(doc.title),
      body: String(doc.body),
      delivery: String(doc.delivery) as DocDelivery,
      author: input.author,
      reason: input.reason,
      sessionId: input.sessionId ?? null,
      at: now,
    })
    return { id: input.id, revisionId }
  })
}

export async function consumeRecordDoc(
  input: Tenant & { id: string; reason: string; author: string; sessionId?: string | null },
): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT * FROM doc
      WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid AND deleted_at IS NULL
    `
    if (!rows[0]) throw new RecordDocError('doc not found', 404)
    const doc = rows[0] as Record<string, unknown>
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
      slug: String(doc.slug),
      projectId: doc.project_id == null ? null : String(doc.project_id),
      op: 'consume',
      title: String(doc.title),
      body: consumed.body,
      delivery: String(doc.delivery) as DocDelivery,
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
  },
): Promise<{ id: string; revisionId: string }> {
  return tenant(input, async (tx) => {
    const revisionRows = await tx`
      SELECT * FROM doc_revision
      WHERE space_id=${input.spaceId}::uuid AND id=${input.revisionId}::uuid AND doc_id=${input.id}::uuid
    `
    if (!revisionRows[0]) throw new RecordDocError('revision not found', 404)
    const revision = revisionRows[0] as Record<string, unknown>
    const scope = String(revision.scope)
    const subject = revision.subject == null ? null : String(revision.subject)
    const slug = String(revision.slug)
    const body = String(revision.body)
    const delivery = String(revision.delivery) as DocDelivery
    const facts = await canonFacts(tx, input.spaceId, scope, subject, slug, body)
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
    const existing = await tx`
      SELECT id FROM doc
      WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid
    `
    if (!existing[0]) throw new RecordDocError('doc not found', 404)
    await tx`
      UPDATE doc
      SET title=${String(revision.title)}, body=${body}, delivery=${delivery},
          deleted_at=NULL, updated_at=${now}::timestamptz
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
    `
    const revisionId = await insertRevision(tx, {
      spaceId: input.spaceId,
      docId: input.id,
      scope,
      subject,
      slug,
      projectId: revision.project_id == null ? null : String(revision.project_id),
      op: 'restore',
      title: String(revision.title),
      body,
      delivery,
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

async function existingDocAtAddress(
  tx: SQL,
  spaceId: string,
  doc: RecordDocImportInput['doc'],
): Promise<Record<string, unknown> | undefined> {
  const rows = await tx`
    SELECT * FROM doc
    WHERE space_id=${spaceId}::uuid
      AND scope=${doc.scope}
      AND COALESCE(subject, '')=${doc.subject ?? ''}
      AND slug=${doc.slug}
    ORDER BY (deleted_at IS NULL) DESC, updated_at DESC, id DESC
    LIMIT 1
  `
  return rows[0] as Record<string, unknown> | undefined
}

function refuseNewerHosted(
  existing: Record<string, unknown> | undefined,
  incoming: RecordDocImportInput['doc'],
): void {
  if (!existing || existing.deleted_at != null) return
  if (String(existing.body) === incoming.body) return
  const hostedUpdated = Date.parse(iso(existing.updated_at) ?? '')
  const incomingUpdated = Date.parse(incoming.updatedAt)
  if (!Number.isFinite(hostedUpdated) || hostedUpdated <= incomingUpdated) return
  const subject = existing.subject == null ? '' : String(existing.subject)
  throw new RecordDocError(
    `refusing import: hosted doc at ${String(existing.scope)}/${subject}/${String(existing.slug)} has a different body and newer updated_at`,
    409,
  )
}

async function writeImportedDoc(
  tx: SQL,
  input: {
    spaceId: string
    id: string
    exists: boolean
    projectId: string | null
    doc: RecordDocImportInput['doc']
  },
): Promise<void> {
  const { doc, spaceId, id, projectId } = input
  if (input.exists) {
    await tx`
      UPDATE doc
      SET title=${doc.title}, body=${doc.body}, delivery=${doc.delivery},
          project_id=${projectId}::uuid,
          created_at=${doc.createdAt}::timestamptz,
          updated_at=${doc.updatedAt}::timestamptz,
          deleted_at=${doc.deletedAt}::timestamptz
      WHERE id=${id}::uuid AND space_id=${spaceId}::uuid
    `
    return
  }
  await tx`
    INSERT INTO doc (
      id, space_id, scope, subject, slug, title, body, delivery, project_id,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${id}::uuid, ${spaceId}::uuid, ${doc.scope}, ${doc.subject}, ${doc.slug},
      ${doc.title}, ${doc.body}, ${doc.delivery}, ${projectId}::uuid,
      ${doc.createdAt}::timestamptz, ${doc.updatedAt}::timestamptz, ${doc.deletedAt}::timestamptz
    )
  `
}

export async function importRecordDoc(
  input: Tenant & RecordDocImportInput,
): Promise<{ id: string; revisionIds: string[] }> {
  return tenant(input, async (tx) => {
    const existing = await existingDocAtAddress(tx, input.spaceId, input.doc)
    if (existing && input.doc.deletedAt !== null && existing.deleted_at == null) {
      const subject = existing.subject == null ? '' : String(existing.subject)
      throw new RecordDocError(
        `refusing import at ${String(existing.scope)}/${subject}/${String(existing.slug)}: a deleted import never targets a live row; delete the live doc through the doc service first if deletion is intended`,
        409,
      )
    }
    refuseNewerHosted(existing, input.doc)
    assertWrite(
      recordDocLintRefusal(
        input.doc,
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
    const resolvedProject = await projectId(tx, input.spaceId, input.doc.projectName)
    const id = existing ? String(existing.id) : newRecordId()
    await writeImportedDoc(tx, {
      spaceId: input.spaceId,
      id,
      exists: Boolean(existing),
      projectId: resolvedProject,
      doc: input.doc,
    })
    const revisionIds: string[] = []
    for (const revision of input.revisions) {
      revisionIds.push(
        await insertRevision(tx, {
          spaceId: input.spaceId,
          docId: id,
          scope: revision.scope,
          subject: revision.subject,
          slug: revision.slug,
          projectId: resolvedProject,
          op: revision.op,
          title: revision.title,
          body: revision.body,
          delivery: revision.delivery,
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
