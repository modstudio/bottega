// concern: record-canon-import
/** Owns tenant-bound hosted canon imports. Must not know local cache, CLI, or HTTP. */

import { SQL } from 'bun'
import { assertDocSections } from '../../../shared/doc-sections.ts'
import type { DocKind, DocStatus } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { planCanonImport } from '../canon/canon-import-policy.ts'
import type { CanonFinding } from '../canon/canon-lint.ts'
import { nonCurrentCanonCollisionRefusal } from '../doc/canon-import-collision.ts'
import { canonFindingsRefusal } from '../doc/doc-write-allowed.ts'
import { recordCanonImportSurroundings } from './record-canon-facts.ts'
import { hostedArticleProjectId } from './record-doc-article-fields.ts'
import { bindRecordDocAudiences } from './record-doc-audience-sql.ts'
import { assertRevisionWrite, assertWrite, RecordDocError } from './record-doc-errors.ts'
import { insertRecordDocRevision } from './record-doc-revision-write.ts'
import { recordCanonTreeWriteRefusal } from './record-doc-tree.ts'

export type RecordCanonImportInput = {
  address: { kind: 'user' } | { kind: 'project'; subject: string; projectId: string }
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
type CanonImportRow = RecordCanonImportInput['rows'][number]
type StoredCanonRow = Record<string, unknown>

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
    const id = prior ? String(prior.record_id) : newRecordId()
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
    const id = String(prior.record_id)
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
            projectId: await hostedArticleProjectId(
              tx,
              input.spaceId,
              input.address.subject,
              input.address.projectId,
            ),
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
