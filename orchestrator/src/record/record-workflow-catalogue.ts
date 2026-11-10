// concern: record-workflow-catalogue
/** Owns tenant-bound hosted workflow catalogue reads and lifecycle writes. */
import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { type RecordCursor, type RecordListCursorRow, recordCursorAt } from './record-cursor.ts'
import { recordPool } from './record-pool.ts'
import {
  type RecordWorkflowDraftInput,
  RecordWorkflowError,
  type RecordWorkflowKind,
  type RecordWorkflowTable,
  type RecordWorkflowTransitionInput,
  workflowVersionConflict,
} from './record-workflow-contract.ts'

type Tenant = { url: string } & TenantPrincipal
const text = (value: unknown) => String(value)
const number = (value: unknown) => Number(value)
const nullable = (value: unknown) => (value == null ? null : String(value))
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value))
const nullableIso = (value: unknown) => (value == null ? null : iso(value))

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return use(tx)
  })
}

function mapped(table: RecordWorkflowTable, row: Record<string, unknown>) {
  const common = { id: text(row.id), spaceId: text(row.space_id) }
  if (table === 'workflow' || table === 'step_catalogue')
    return {
      ...common,
      slug: text(row.slug),
      generation: number(row.generation),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  if (table.endsWith('_version'))
    return {
      ...common,
      ownerId: text(row[table === 'workflow_version' ? 'workflow_id' : 'catalogue_id']),
      n: number(row.n),
      status: text(row.status),
      definition: text(row.definition),
      author: text(row.author),
      reason: text(row.reason),
      createdAt: iso(row.created_at),
      promotedAt: nullableIso(row.promoted_at),
      retiredAt: nullableIso(row.retired_at),
      updatedAt: iso(row.updated_at),
    }
  return {
    ...common,
    ownerVersionId: text(
      row[table === 'workflow_event' ? 'workflow_version_id' : 'catalogue_version_id'],
    ),
    event: text(row.event),
    author: text(row.author),
    reason: text(row.reason),
    sessionId: nullable(row.session_id),
    at: iso(row.at),
    updatedAt: iso(row.updated_at),
  }
}

export { mapped as mapRecordWorkflowRow }

export async function recordWorkflowRows(
  tx: SQL,
  table: RecordWorkflowTable,
  select:
    | { ids: readonly string[] }
    | { spaceId: string; cursor: RecordCursor | null; limit: number },
): Promise<Record<string, unknown>[]> {
  const from = `SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM ${table}`
  if ('ids' in select)
    return tx.unsafe(
      `${from} WHERE id=ANY(string_to_array($1,',')::uuid[]) ORDER BY updated_at,id LIMIT $2`,
      [select.ids.join(','), select.ids.length],
    ) as Promise<Record<string, unknown>[]>
  return tx.unsafe(
    `${from} WHERE space_id=$1::uuid AND ($2::timestamptz IS NULL OR (updated_at,id)>($2::timestamptz,$3::uuid)) ORDER BY updated_at,id LIMIT $4`,
    [select.spaceId, select.cursor?.at ?? null, select.cursor?.id ?? null, select.limit + 1],
  ) as Promise<Record<string, unknown>[]>
}

export async function listRecordWorkflowCatalogue(
  input: Tenant & { table: RecordWorkflowTable; limit: number; cursor: RecordCursor | null },
): Promise<(Record<string, unknown> & RecordListCursorRow)[]> {
  return tenant(input, async (tx) => {
    const rows = await recordWorkflowRows(tx, input.table, input)
    return rows.map((row) => ({
      ...mapped(input.table, row),
      [recordCursorAt]: text(row.cursor_at),
    }))
  })
}

async function identity(
  tx: SQL,
  input: Tenant & { kind: RecordWorkflowKind; slug: string },
  create: boolean,
) {
  await tx`SELECT id FROM space WHERE id=${input.spaceId}::uuid FOR UPDATE`
  let rows =
    input.kind === 'workflow'
      ? await tx`SELECT * FROM workflow WHERE space_id=${input.spaceId}::uuid AND slug=${input.slug} FOR UPDATE`
      : await tx`SELECT * FROM step_catalogue WHERE space_id=${input.spaceId}::uuid AND slug=${input.slug} FOR UPDATE`
  if (!rows[0] && create) {
    const id = newRecordId(),
      now = new Date().toISOString()
    if (input.kind === 'workflow')
      await tx`INSERT INTO workflow (id,space_id,slug,generation,created_at,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.slug},1,${now}::timestamptz,${now}::timestamptz)`
    else
      await tx`INSERT INTO step_catalogue (id,space_id,slug,generation,created_at,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${input.slug},1,${now}::timestamptz,${now}::timestamptz)`
    rows =
      input.kind === 'workflow'
        ? await tx`SELECT * FROM workflow WHERE id=${id}::uuid`
        : await tx`SELECT * FROM step_catalogue WHERE id=${id}::uuid`
  }
  if (!rows[0])
    throw new RecordWorkflowError(
      `unknown hosted ${input.kind === 'workflow' ? 'workflow' : 'step catalogue'} "${input.slug}"`,
      404,
    )
  return rows[0]!
}

async function versions(tx: SQL, kind: RecordWorkflowKind, spaceId: string, ownerId: string) {
  return (
    kind === 'workflow'
      ? await tx`SELECT * FROM workflow_version WHERE space_id=${spaceId}::uuid AND workflow_id=${ownerId}::uuid ORDER BY n`
      : await tx`SELECT * FROM step_catalogue_version WHERE space_id=${spaceId}::uuid AND catalogue_id=${ownerId}::uuid ORDER BY n`
  ) as Record<string, unknown>[]
}
async function events(tx: SQL, kind: RecordWorkflowKind, spaceId: string, ids: string[]) {
  if (!ids.length) return []
  return (
    kind === 'workflow'
      ? await tx`SELECT * FROM workflow_event WHERE space_id=${spaceId}::uuid AND workflow_version_id IN ${tx(ids)} ORDER BY at,id`
      : await tx`SELECT * FROM step_catalogue_event WHERE space_id=${spaceId}::uuid AND catalogue_version_id IN ${tx(ids)} ORDER BY at,id`
  ) as Record<string, unknown>[]
}
async function response(
  tx: SQL,
  input: Tenant & { kind: RecordWorkflowKind; slug: string },
  owner: Record<string, unknown>,
  changedEvents: string[],
) {
  const versionRows = await versions(tx, input.kind, input.spaceId, text(owner.id))
  const eventRows = await events(tx, input.kind, input.spaceId, changedEvents)
  const identityTable = input.kind === 'workflow' ? 'workflow' : 'step_catalogue'
  const versionTable = input.kind === 'workflow' ? 'workflow_version' : 'step_catalogue_version'
  const eventTable = input.kind === 'workflow' ? 'workflow_event' : 'step_catalogue_event'
  return {
    identity: mapped(identityTable, owner),
    versions: versionRows.map((row) => mapped(versionTable, row)),
    events: eventRows.map((row) => mapped(eventTable, row)),
  }
}

function unique(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
    throw new RecordWorkflowError(
      'hosted workflow catalogue changed concurrently; refresh and retry',
    )
  throw error
}

export async function draftRecordWorkflow(input: Tenant & RecordWorkflowDraftInput) {
  try {
    return await tenant(input, async (tx) => {
      const owner = await identity(tx, input, true),
        ownerId = text(owner.id),
        now = new Date().toISOString()
      const prior = await versions(tx, input.kind, input.spaceId, ownerId)
      const n = prior.reduce((max, row) => Math.max(max, number(row.n)), 0) + 1
      let definition = input.definition
      if (input.event === 'fork') {
        const source =
          input.from == null
            ? prior.find((row) => row.status === 'production')
            : prior.find((row) => number(row.n) === input.from)
        if (!source)
          throw new RecordWorkflowError(
            `hosted ${input.kind} has no ${input.from == null ? 'production version' : `version ${input.from}`}`,
            404,
          )
        definition = text(source.definition)
      }
      if (definition === undefined) throw new RecordWorkflowError('definition is required', 422)
      const versionId = newRecordId(),
        eventId = newRecordId()
      if (input.kind === 'workflow') {
        await tx`INSERT INTO workflow_version (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at) VALUES (${versionId}::uuid,${input.spaceId}::uuid,${ownerId}::uuid,${n},'draft',${definition},${input.author},${input.reason},${now}::timestamptz,${now}::timestamptz)`
        await tx`INSERT INTO workflow_event (id,space_id,workflow_version_id,event,author,reason,session_id,at,updated_at) VALUES (${eventId}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${input.event},${input.author},${input.reason},${input.sessionId ?? null},${now}::timestamptz,${now}::timestamptz)`
        await tx`UPDATE workflow SET updated_at=${now}::timestamptz WHERE id=${ownerId}::uuid`
      } else {
        await tx`INSERT INTO step_catalogue_version (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at) VALUES (${versionId}::uuid,${input.spaceId}::uuid,${ownerId}::uuid,${n},'draft',${definition},${input.author},${input.reason},${now}::timestamptz,${now}::timestamptz)`
        await tx`INSERT INTO step_catalogue_event (id,space_id,catalogue_version_id,event,author,reason,session_id,at,updated_at) VALUES (${eventId}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${input.event},${input.author},${input.reason},${input.sessionId ?? null},${now}::timestamptz,${now}::timestamptz)`
        await tx`UPDATE step_catalogue SET updated_at=${now}::timestamptz WHERE id=${ownerId}::uuid`
      }
      return response(tx, input, { ...owner, updated_at: now }, [versionId])
    })
  } catch (error) {
    return unique(error)
  }
}

async function writeTransitionEvent(
  tx: SQL,
  input: Tenant & RecordWorkflowTransitionInput,
  versionId: string,
  event: 'promote' | 'retire',
  now: string,
) {
  const id = newRecordId()
  if (input.kind === 'workflow')
    await tx`INSERT INTO workflow_event (id,space_id,workflow_version_id,event,author,reason,session_id,at,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${event},${input.author},${input.reason},${input.sessionId ?? null},${now}::timestamptz,${now}::timestamptz)`
  else
    await tx`INSERT INTO step_catalogue_event (id,space_id,catalogue_version_id,event,author,reason,session_id,at,updated_at) VALUES (${id}::uuid,${input.spaceId}::uuid,${versionId}::uuid,${event},${input.author},${input.reason},${input.sessionId ?? null},${now}::timestamptz,${now}::timestamptz)`
}

async function updateTransitionVersion(
  tx: SQL,
  input: Tenant & RecordWorkflowTransitionInput,
  target: Record<string, unknown>,
  action: 'promote' | 'retire',
  now: string,
) {
  const status = action === 'promote' ? 'production' : 'retired'
  const promotedAt = action === 'promote' ? now : nullableIso(target.promoted_at)
  const retiredAt = action === 'retire' ? now : null
  if (input.kind === 'workflow')
    await tx`UPDATE workflow_version SET status=${status},promoted_at=${promotedAt}::timestamptz,retired_at=${retiredAt}::timestamptz,updated_at=${now}::timestamptz WHERE id=${text(target.id)}::uuid`
  else
    await tx`UPDATE step_catalogue_version SET status=${status},promoted_at=${promotedAt}::timestamptz,retired_at=${retiredAt}::timestamptz,updated_at=${now}::timestamptz WHERE id=${text(target.id)}::uuid`
}

async function retireCurrentVersion(
  tx: SQL,
  input: Tenant & RecordWorkflowTransitionInput,
  current: Record<string, unknown>,
  now: string,
) {
  if (input.kind === 'workflow')
    await tx`UPDATE workflow_version SET status='retired',retired_at=${now}::timestamptz,updated_at=${now}::timestamptz WHERE id=${text(current.id)}::uuid`
  else
    await tx`UPDATE step_catalogue_version SET status='retired',retired_at=${now}::timestamptz,updated_at=${now}::timestamptz WHERE id=${text(current.id)}::uuid`
  await writeTransitionEvent(tx, input, text(current.id), 'retire', now)
}

async function touchIdentity(
  tx: SQL,
  input: Tenant & RecordWorkflowTransitionInput,
  ownerId: string,
  now: string,
) {
  if (input.kind === 'workflow')
    await tx`UPDATE workflow SET updated_at=${now}::timestamptz WHERE id=${ownerId}::uuid`
  else await tx`UPDATE step_catalogue SET updated_at=${now}::timestamptz WHERE id=${ownerId}::uuid`
}

async function transition(
  input: Tenant & RecordWorkflowTransitionInput,
  action: 'promote' | 'retire',
) {
  try {
    return await tenant(input, async (tx) => {
      const owner = await identity(tx, input, false),
        ownerId = text(owner.id),
        now = new Date().toISOString()
      const rows = await versions(tx, input.kind, input.spaceId, ownerId)
      const current = rows.find((row) => row.status === 'production')
      const currentN = current ? number(current.n) : null
      if (currentN !== input.expectedProductionVersion)
        throw workflowVersionConflict(input.expectedProductionVersion, currentN)
      const target = rows.find((row) => number(row.n) === input.n)
      if (!target)
        throw new RecordWorkflowError(`hosted ${input.kind} has no version ${input.n}`, 404)
      if (action === 'promote' && target.status !== 'draft')
        throw new RecordWorkflowError(`version ${input.n} is not a draft`)
      if (action === 'retire' && target.status === 'retired')
        throw new RecordWorkflowError(`version ${input.n} is retired`)
      const changed: string[] = []
      if (action === 'promote' && current) {
        changed.push(text(current.id))
        await retireCurrentVersion(tx, input, current, now)
      }
      changed.push(text(target.id))
      await updateTransitionVersion(tx, input, target, action, now)
      await writeTransitionEvent(tx, input, text(target.id), action, now)
      await touchIdentity(tx, input, ownerId, now)
      return response(tx, input, { ...owner, updated_at: now }, changed)
    })
  } catch (error) {
    return unique(error)
  }
}
export const promoteRecordWorkflow = (input: Tenant & RecordWorkflowTransitionInput) =>
  transition(input, 'promote')
export const retireRecordWorkflow = (input: Tenant & RecordWorkflowTransitionInput) =>
  transition(input, 'retire')
