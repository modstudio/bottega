// concern: record-context-items
/** Owns tenant-bound hosted context-item mutations. */
import type { SQL } from 'bun'
import type { ContextHolderKind, ContextItemKind } from '../../../shared/context-item-vocabulary.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'
import { contextItemShapeRefusal } from '../doc/doc-context-write.ts'
import { assertWrite } from './record-doc-errors.ts'
import { recordPool } from './record-pool.ts'

type Tenant = { url: string } & TenantPrincipal
export type RecordContextItemInput = {
  id?: string
  holderKind: ContextHolderKind
  holderId: string
  slug: string
  kind: ContextItemKind
  body: string
  source: string
  questionNumber: number | null
  target: string | null
  expectedRevision?: string
}

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return use(tx)
  })
}

function output(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    createdAt: recordIso(row.created_at),
    updatedAt: recordIso(row.updated_at),
  }
}

export async function upsertRecordContextItem(input: Tenant & RecordContextItemInput) {
  assertWrite(
    contextItemShapeRefusal({
      holder: `${input.holderKind}:${input.holderId}`,
      id: input.slug,
      kind: input.kind,
      body: input.body,
      source: input.source,
      questionNumber: input.questionNumber,
      target: input.target,
    }),
  )
  return tenant(input, async (tx) => {
    const rows = (await tx`
      SELECT id,created_at,updated_at FROM context_item
      WHERE space_id=${input.spaceId}::uuid AND holder_kind=${input.holderKind}
        AND holder_id=${input.holderId} AND slug=${input.slug}
      FOR UPDATE
    `) as Record<string, unknown>[]
    const current = rows[0]
    const currentRevision = current ? recordIso(current.updated_at) : undefined
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new Error(
        `context item changed; expected revision ${input.expectedRevision}, current revision ${currentRevision ?? 'missing'}`,
      )
    }
    const id = current ? String(current.id) : (input.id ?? newRecordId())
    const written = (await tx`
      INSERT INTO context_item(
        id,space_id,holder_kind,holder_id,slug,kind,body,source,question_number,target,created_at,updated_at
      ) VALUES (
        ${id}::uuid,${input.spaceId}::uuid,${input.holderKind},${input.holderId},${input.slug},
        ${input.kind},${input.body},${input.source},${input.questionNumber},${input.target},now(),now()
      )
      ON CONFLICT (space_id,holder_kind,holder_id,slug) DO UPDATE SET
        kind=excluded.kind,body=excluded.body,source=excluded.source,
        question_number=excluded.question_number,target=excluded.target,updated_at=now()
      RETURNING id,created_at,updated_at
    `) as Record<string, unknown>[]
    return output(written[0]!)
  })
}

export async function deleteRecordContextItem(
  input: Tenant & { id: string; expectedRevision?: string },
) {
  return tenant(input, async (tx) => {
    const rows = (await tx`
      SELECT updated_at FROM context_item WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid
      FOR UPDATE
    `) as Record<string, unknown>[]
    if (!rows.length) return { removed: false }
    const revision = recordIso(rows[0]!.updated_at)
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
      throw new Error(
        `context item changed; expected revision ${input.expectedRevision}, current revision ${revision}`,
      )
    }
    await tx`DELETE FROM context_item WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid`
    return { removed: true }
  })
}
