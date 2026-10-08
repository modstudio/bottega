import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../shared/record/tenant.ts'
import {
  hostedTaskJoin,
  hostedTaskRelationship,
  repairHostedTaskReferences,
  taskIdFor,
} from './hosted-task-reference.ts'

export type TaskIdentity = TenantPrincipal
export type HostedTask = {
  id: string
  newly_assigned?: boolean
  key: string
  project: string
  project_name: string
  title: string | null
  status: string | null
  status_category: string | null
  parent_key: string | null
  parent_id?: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  source: 'mcp' | 'git' | 'local'
  first_seen: string
  last_seen: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export type HostedComment = {
  id: string
  legacy_local_id: number | null
  newly_assigned?: boolean
  task_key: string
  task_id?: string | null
  project_name: string
  body: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export type HostedDocument = {
  id: string
  legacy_local_id: number | null
  newly_assigned?: boolean
  task_key: string
  task_id?: string | null
  project_name: string
  role: string | null
  title: string
  body: string
  version: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export type HostedStatusEvent = {
  id: string
  legacy_local_id: number | null
  newly_assigned?: boolean
  task_key: string
  task_id?: string | null
  project_name: string
  at: string
  from_status: string | null
  to_status: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export async function withHostedTenant<T>(
  url: string,
  identity: TaskIdentity,
  work: (tx: SQL) => Promise<T>,
) {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, identity)
      return work(tx)
    })
  } finally {
    await client.close()
  }
}

const rows = <T>(value: unknown) => value as T[]

export async function listHostedTasks(
  url: string,
  identity: TaskIdentity,
  filters: {
    project?: string
    status?: string
    parent?: string
    updatedSince?: string
    includeDeleted?: boolean
    cursor?: string
  },
) {
  return withHostedTenant(url, identity, async (tx) => {
    const since = filters.updatedSince ?? filters.cursor ?? '1970-01-01T00:00:00.000Z'
    const parentId = filters.parent ? await taskIdFor(tx, identity.spaceId, filters.parent) : null
    const parent = hostedTaskRelationship('hub_task')
    const tasks = rows<HostedTask>(
      await tx`
      SELECT * FROM hub_task WHERE space_id=${identity.spaceId}::uuid
        AND (${filters.project ?? null}::text IS NULL OR project_name=${filters.project ?? null})
        AND (${filters.status ?? null}::text IS NULL OR status_category=${filters.status ?? null})
        AND (${filters.parent ?? null}::text IS NULL
          OR ${tx.unsafe(parent.idColumn)}=${parentId}::uuid
          OR (${tx.unsafe(parent.idColumn)} IS NULL AND
            ${tx.unsafe(parent.keyColumn)}=${filters.parent ?? null}))
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at, key`,
    )
    const comments = rows<HostedComment>(
      await tx`
      SELECT * FROM hub_task_comment WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
        ORDER BY updated_at,id`,
    )
    const documents = rows<HostedDocument>(
      await tx`
      SELECT * FROM hub_task_document WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
        ORDER BY updated_at,id`,
    )
    const statusEvents = rows<HostedStatusEvent>(
      await tx`
      SELECT * FROM hub_task_status_event WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
        ORDER BY updated_at,id`,
    )
    const changed = [...tasks, ...comments, ...documents, ...statusEvents]
    const cursor = changed.reduce((latest, row) => {
      const stamp = new Date(row.updated_at).toISOString()
      return stamp > latest ? stamp : latest
    }, since)
    return { tasks, comments, documents, statusEvents, cursor }
  })
}

export async function getHostedTask(url: string, identity: TaskIdentity, key: string) {
  return withHostedTenant(url, identity, async (tx) => {
    const task = rows<HostedTask>(
      await tx`
      SELECT * FROM hub_task WHERE space_id=${identity.spaceId}::uuid AND key=${key}
        AND deleted_at IS NULL`,
    )[0]
    if (!task) return null
    const comments = rows<HostedComment>(
      await tx`
      SELECT c.* FROM hub_task_comment c JOIN hub_task t ON ${hostedTaskJoin(tx, 'hub_task_comment', 'c')}
        WHERE t.id=${task.id}::uuid AND c.space_id=${identity.spaceId}::uuid
        AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`,
    )
    const documents = rows<HostedDocument>(
      await tx`
      SELECT d.* FROM hub_task_document d JOIN hub_task t ON ${hostedTaskJoin(tx, 'hub_task_document', 'd')}
        WHERE t.id=${task.id}::uuid AND d.space_id=${identity.spaceId}::uuid
        AND d.deleted_at IS NULL ORDER BY d.created_at,d.id`,
    )
    return { task, comments, documents }
  })
}

export async function createHostedTask(
  url: string,
  identity: TaskIdentity,
  input: {
    project: string
    title: string
    status?: string
    parent?: string
    body?: string
    opened_at?: string
    closed_at?: string | null
    updated_at?: string
  },
) {
  return withHostedTenant(url, identity, (tx) => createHostedTaskInTransaction(tx, identity, input))
}

export async function createHostedTaskInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  input: Parameters<typeof createHostedTask>[2],
) {
  const project = rows<{ id: string; key_prefixes: string[] }>(
    await tx`
      SELECT id,key_prefixes FROM project WHERE space_id=${identity.spaceId}::uuid
        AND name=${input.project}`,
  )[0]
  if (!project)
    throw new Error(
      `project '${input.project}' is absent from record space ${identity.spaceId}. ` +
        `Run \`orch record space move-project\` or declare the project's space in the register.`,
    )
  const prefix = project?.key_prefixes[0]
  if (!prefix) throw new Error(`project '${input.project}' has no key prefix`)
  const pattern = `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9]+)$`
  const highest = rows<{ highest: string | null }>(
    await tx`
      SELECT MAX(((regexp_match(key, ${pattern}, 'i'))[1])::bigint)::text highest
      FROM hub_task WHERE space_id=${identity.spaceId}::uuid`,
  )[0]?.highest
  await tx`INSERT INTO seq(space_id,project_id,name,next)
      VALUES (${identity.spaceId}::uuid,${project.id}::uuid,${`task:${prefix}`},${BigInt(highest ?? 0) + 1n})
      ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
  const sequence = rows<{ next: string }>(
    await tx`
      SELECT next::text FROM seq WHERE space_id=${identity.spaceId}::uuid
        AND project_id=${project.id}::uuid AND name=${`task:${prefix}`} FOR UPDATE`,
  )[0]
  const number = BigInt(sequence!.next)
  const key = `${prefix.toUpperCase()}-${number}`
  const id = newRecordId()
  const category = input.status ?? 'open'
  const openedAt = input.opened_at ?? new Date().toISOString()
  const updatedAt = input.updated_at ?? input.closed_at ?? openedAt
  const closedAt = input.closed_at ?? (category === 'done' ? updatedAt : null)
  const parentId = await taskIdFor(tx, identity.spaceId, input.parent ?? null)
  await tx`UPDATE seq SET next=${number + 1n} WHERE space_id=${identity.spaceId}::uuid
      AND project_id=${project.id}::uuid AND name=${`task:${prefix}`}`
  const inserted = rows<HostedTask>(
    await tx`
      INSERT INTO hub_task
        (id,space_id,project_name,key,project,title,status,status_category,parent_key,parent_id,body,
         opened_at,closed_at,source,first_seen,last_seen,created_at,updated_at)
      VALUES (${id}::uuid,${identity.spaceId}::uuid,${input.project},${key},${input.project},
        ${input.title},${category},${category},${input.parent ?? null},${parentId}::uuid,${input.body ?? null},${openedAt}::timestamptz,
        ${closedAt}::timestamptz,'local',${openedAt}::timestamptz,${updatedAt}::timestamptz,now(),${updatedAt}::timestamptz) RETURNING *`,
  )
  return inserted[0]!
}

export async function patchHostedTask(
  url: string,
  identity: TaskIdentity,
  key: string,
  changes: Partial<
    Pick<HostedTask, 'title' | 'status' | 'status_category' | 'parent_key' | 'body' | 'assignee'>
  >,
) {
  return withHostedTenant(url, identity, async (tx) => {
    const current = rows<HostedTask>(
      await tx`SELECT * FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} AND deleted_at IS NULL FOR UPDATE`,
    )[0]
    if (!current) return null
    const at = new Date().toISOString()
    const category = changes.status_category ?? changes.status ?? current.status_category
    const parentKey = changes.parent_key === undefined ? current.parent_key : changes.parent_key
    const parentId = await taskIdFor(tx, identity.spaceId, parentKey)
    const updated = rows<HostedTask>(
      await tx`UPDATE hub_task SET
      title=${changes.title === undefined ? current.title : changes.title},
      status=${changes.status === undefined ? current.status : changes.status},
      status_category=${category},
      parent_key=${parentKey},parent_id=${parentId}::uuid,
      body=${changes.body === undefined ? current.body : changes.body},
      assignee=${changes.assignee === undefined ? current.assignee : changes.assignee},
      closed_at=CASE WHEN ${category}='done' THEN COALESCE(closed_at,${at}::timestamptz) ELSE NULL END,
      updated_at=${at}::timestamptz,last_seen=${at}::timestamptz
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} RETURNING *`,
    )
    let statusEvent: HostedStatusEvent | undefined
    if (category !== current.status_category && category) {
      statusEvent = rows<HostedStatusEvent>(
        await tx`INSERT INTO hub_task_status_event
        (id,space_id,project_name,task_key,task_id,at,from_status,to_status,created_at,updated_at)
        VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${current.project_name},${key},${current.id}::uuid,
          ${at}::timestamptz,${current.status_category},${category},${at}::timestamptz,${at}::timestamptz)
        ON CONFLICT (space_id,task_key,to_status,at) DO NOTHING RETURNING *`,
      )[0]
    }
    return { ...updated[0]!, status_event: statusEvent }
  })
}

export async function addHostedComment(
  url: string,
  identity: TaskIdentity,
  key: string,
  body: string,
) {
  return withHostedTenant(url, identity, async (tx) => {
    const project = rows<{ id: string; project_name: string }>(
      await tx`SELECT id,project_name FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} AND deleted_at IS NULL`,
    )[0]
    if (!project) return null
    const comment = rows<HostedComment>(
      await tx`INSERT INTO hub_task_comment
      (id,space_id,project_name,task_key,task_id,body,created_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${project.project_name},${key},${project.id}::uuid,${body},now(),now()) RETURNING *`,
    )[0]!
    await tx`UPDATE hub_task SET updated_at=${comment.updated_at}::timestamptz,last_seen=${comment.updated_at}::timestamptz
      WHERE space_id=${identity.spaceId}::uuid AND key=${key}`
    return comment
  })
}

export async function createHostedDocument(
  url: string,
  identity: TaskIdentity,
  key: string,
  input: { title: string; body?: string; role?: string | null; version: string },
) {
  return withHostedTenant(url, identity, async (tx) => {
    const project = rows<{ id: string; project_name: string }>(
      await tx`SELECT id,project_name FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} AND deleted_at IS NULL`,
    )[0]
    if (!project) return null
    return rows<HostedDocument>(
      await tx`INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,task_id,role,title,body,version,created_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${project.project_name},${key},${project.id}::uuid,
       ${input.role ?? null},${input.title},${input.body ?? ''},${input.version},now(),now()) RETURNING *`,
    )[0]!
  })
}

export async function patchHostedDocument(
  url: string,
  identity: TaskIdentity,
  id: string,
  input: {
    title?: string
    body?: string
    role?: string | null
    expectedVersion?: string
    version: string
  },
) {
  return withHostedTenant(url, identity, async (tx) => {
    const current = rows<HostedDocument>(
      await tx`SELECT * FROM hub_task_document WHERE
      space_id=${identity.spaceId}::uuid AND id=${id}::uuid AND deleted_at IS NULL FOR UPDATE`,
    )[0]
    if (!current) return null
    if (input.body !== undefined && input.expectedVersion !== current.version)
      throw new Error(`task document changed since version ${input.expectedVersion}`)
    return rows<HostedDocument>(
      await tx`UPDATE hub_task_document SET
      title=${input.title ?? current.title},body=${input.body ?? current.body},
      role=${input.role === undefined ? current.role : input.role},version=${input.version},updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND id=${id}::uuid RETURNING *`,
    )[0]!
  })
}

export type ConfirmationPolicy = 'exact-always' | 'bulk-only'

export function confirmCount(
  count: number,
  confirmation: number | undefined,
  policy: ConfirmationPolicy,
) {
  if ((policy === 'exact-always' || count > 1) && confirmation !== count)
    throw new Error(`refusing to delete ${count} rows without confirmation count ${count}`)
}

export async function softDeleteHostedDocuments(
  url: string,
  identity: TaskIdentity,
  ids: string[],
  confirmation?: number,
) {
  return withHostedTenant(url, identity, async (tx) => {
    const found = rows<{ id: string }>(
      await tx`SELECT id FROM hub_task_document WHERE
      space_id=${identity.spaceId}::uuid AND id IN ${tx(ids)} AND deleted_at IS NULL FOR UPDATE`,
    )
    confirmCount(found.length, confirmation, 'bulk-only')
    if (found.length)
      await tx`UPDATE hub_task_document SET deleted_at=now(),updated_at=now()
        WHERE space_id=${identity.spaceId}::uuid AND id IN ${tx(found.map((row) => row.id))}`
    return { deleted: found.length }
  })
}

type MirrorBody = {
  tasks: HostedTask[]
  expectedSpaceId?: string
  comments?: HostedComment[]
  documents?: HostedDocument[]
  statusEvents?: HostedStatusEvent[]
  raiseSequences?: Array<{ project: string; prefix: string; next: number }>
}

class MirrorExpectedSpaceMismatchError extends Error {
  override name = 'MirrorExpectedSpaceMismatchError'
}

/** Refuse a mirror selected for a different active space before opening a transaction. */
export function assertMirrorExpectedSpace(
  expectedSpaceId: string | undefined,
  actualSpaceId: string,
) {
  if (expectedSpaceId === undefined || expectedSpaceId === actualSpaceId) return
  throw new MirrorExpectedSpaceMismatchError(
    `mirror expected space ${expectedSpaceId}, actual space ${actualSpaceId}; re-run after the active space settles`,
  )
}

export function isMirrorExpectedSpaceMismatch(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('mirror expected space ') &&
    message.includes('actual space ') &&
    message.includes('re-run after the active space settles')
  )
}

type MirrorIdentity = { id: string; spaceId: string; naturalKey: string }
type MirrorLegacyLocalIdHolder = { id: string; spaceId: string; legacyLocalId: number }
type MirrorCollisionDecision =
  | { action: 'insert' }
  | { action: 'update-same-row' }
  | { action: 'idempotent-duplicate' }
  | { action: 'adopt'; id: string }
  | { action: 'refuse'; reason: string }

function naturalKeyCollisionDecision(
  incoming: MirrorIdentity,
  existing: MirrorIdentity | null,
  mayAdopt: boolean,
  naturalKeyHolder: MirrorIdentity | null,
): MirrorCollisionDecision | null {
  if (!naturalKeyHolder || naturalKeyHolder.id === incoming.id) return null
  if (!existing && mayAdopt && naturalKeyHolder.spaceId === incoming.spaceId)
    return { action: 'adopt', id: naturalKeyHolder.id }
  return {
    action: 'refuse',
    reason:
      `refusing to mirror ${incoming.naturalKey} with id ${incoming.id}: ` +
      `${naturalKeyHolder.naturalKey} in space ${naturalKeyHolder.spaceId} already belongs to ` +
      `id ${naturalKeyHolder.id}; restore this local row's record id to ` +
      `${naturalKeyHolder.id}, change the task key in that space, or ask the hosted-space ` +
      `operator to resolve the task key collision`,
  }
}

function legacyLocalIdCollisionDecision(
  incoming: MirrorIdentity,
  mayAdopt: boolean,
  legacyLocalIdHolder: MirrorLegacyLocalIdHolder | null,
): MirrorCollisionDecision | null {
  if (!legacyLocalIdHolder || legacyLocalIdHolder.id === incoming.id) return null
  if (mayAdopt && legacyLocalIdHolder.spaceId === incoming.spaceId)
    return { action: 'adopt', id: legacyLocalIdHolder.id }
  return {
    action: 'refuse',
    reason:
      `refusing to mirror ${incoming.naturalKey} with id ${incoming.id}: legacy local id ` +
      `${legacyLocalIdHolder.legacyLocalId} in space ${legacyLocalIdHolder.spaceId} already ` +
      `belongs to id ${legacyLocalIdHolder.id}; restore this local row's record id to ` +
      `${legacyLocalIdHolder.id}, or ask the hosted-space operator to resolve the local id collision`,
  }
}

export function mirrorCollisionDecision(
  incoming: MirrorIdentity,
  existing: MirrorIdentity | null,
  sameRow: 'update' | 'idempotent',
  identity: 'natural-key' | 'id' | 'status-event' = 'natural-key',
  legacyLocalIdHolder: MirrorLegacyLocalIdHolder | null = null,
  mayAdopt = false,
  naturalKeyHolder: MirrorIdentity | null = null,
): MirrorCollisionDecision {
  if (existing && existing.spaceId !== incoming.spaceId)
    return {
      action: 'refuse',
      reason:
        `refusing to mirror ${incoming.naturalKey}: id ${incoming.id} already belongs to ` +
        `${existing.naturalKey} in space ${existing.spaceId}; restore this local row's record id ` +
        `to the id for ${incoming.naturalKey}, or ask the hosted-space operator to resolve the id collision`,
    }
  const naturalKeyCollision =
    identity !== 'id'
      ? naturalKeyCollisionDecision(
          incoming,
          existing,
          identity === 'status-event' || mayAdopt,
          naturalKeyHolder,
        )
      : null
  if (naturalKeyCollision) return naturalKeyCollision
  if (!existing) {
    const legacyCollision = legacyLocalIdCollisionDecision(incoming, mayAdopt, legacyLocalIdHolder)
    if (legacyCollision) return legacyCollision
    return { action: 'insert' }
  }
  return { action: sameRow === 'update' ? 'update-same-row' : 'idempotent-duplicate' }
}

function applyMirrorDecision(decision: MirrorCollisionDecision): boolean {
  if (decision.action === 'refuse') throw new Error(decision.reason)
  return decision.action !== 'idempotent-duplicate' && decision.action !== 'adopt'
}

export type MirrorAdoption =
  | {
      table: 'task'
      project: string
      key: string
      id: string
    }
  | {
      table: 'task_comment' | 'task_document' | 'task_status_event'
      legacy_local_id: number
      id: string
    }

export function isTaskMirrorAdoption(
  adoption: MirrorAdoption,
): adoption is Extract<MirrorAdoption, { table: 'task' }> {
  return adoption.table === 'task'
}

function taskRowMayAdopt(row: HostedTask): boolean {
  return row.source === 'mcp' || row.source === 'git' || row.newly_assigned === true
}

function taskMirrorAdoption(row: HostedTask, id: string): MirrorAdoption {
  return { table: 'task', project: row.project, key: row.key, id }
}

function selectedMirrorIdentity<T extends { id: string; space_id: string }>(
  row: T | undefined,
  naturalKey: (row: T) => string,
): MirrorIdentity | null {
  return row ? { id: row.id, spaceId: row.space_id, naturalKey: naturalKey(row) } : null
}

function localMirrorNaturalKey(kind: 'comment' | 'document' | 'status event', id: number | null) {
  return id === null ? `${kind} with no local id` : `${kind} ${id}`
}

function statusEventMirrorNaturalKey(row: HostedStatusEvent) {
  return `status event for task ${row.task_id ?? row.task_key} to ${row.to_status} at ${row.at}`
}

type HostedStatusEventHolder = {
  id: string
  space_id: string
  legacy_local_id: number | null
  task_id: string | null
  from_status: string | null
}

async function statusEventNaturalKeyHolder(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedStatusEvent,
): Promise<HostedStatusEventHolder | undefined> {
  if (row.task_id)
    return rows<HostedStatusEventHolder>(
      await tx`SELECT id,space_id,legacy_local_id,task_id,from_status
        FROM hub_task_status_event
        WHERE space_id=${identity.spaceId}::uuid
          AND (task_id=${row.task_id}::uuid OR
            (task_id IS NULL AND task_key=${row.task_key}))
          AND to_status=${row.to_status} AND at=${row.at}::timestamptz`,
    )[0]
  return rows<HostedStatusEventHolder>(
    await tx`SELECT id,space_id,legacy_local_id,task_id,from_status
      FROM hub_task_status_event
      WHERE space_id=${identity.spaceId}::uuid AND task_key=${row.task_key}
        AND to_status=${row.to_status} AND at=${row.at}::timestamptz`,
  )[0]
}

async function updateMirroredStatusEvent(
  tx: SQL,
  row: HostedStatusEvent,
  taskId: string | null,
  decision: { action: 'idempotent-duplicate' } | { action: 'adopt'; id: string },
  naturalKeyHolder: HostedStatusEventHolder | undefined,
): Promise<MirrorAdoption | null> {
  const id = decision.action === 'adopt' ? decision.id : row.id
  const naturalKeyAdoption = decision.action === 'adopt' && naturalKeyHolder?.id === decision.id
  if (naturalKeyAdoption) {
    if (naturalKeyHolder.from_status !== row.from_status)
      console.error(
        `hub: status event ${decision.id} kept from_status ${naturalKeyHolder.from_status ?? 'null'} instead of incoming ${row.from_status ?? 'null'}`,
      )
    await tx`UPDATE hub_task_status_event SET
      legacy_local_id=COALESCE(legacy_local_id,${row.legacy_local_id}),
      task_id=COALESCE(task_id,${taskId}::uuid)
      WHERE id=${id}::uuid`
  } else
    await tx`UPDATE hub_task_status_event SET
      legacy_local_id=COALESCE(legacy_local_id,${row.legacy_local_id}),
      task_key=${row.task_key},task_id=${taskId}::uuid
      WHERE id=${id}::uuid`
  return decision.action === 'adopt'
    ? { table: 'task_status_event', legacy_local_id: row.legacy_local_id!, id }
    : null
}

async function mirrorTaskRow(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedTask,
): Promise<MirrorAdoption | null> {
  const existing = rows<{ id: string; space_id: string; key: string }>(
    await tx`SELECT id,space_id,key FROM hub_task WHERE id=${row.id}::uuid`,
  )[0]
  const keyHolder = rows<{ id: string; space_id: string; key: string }>(
    await tx`SELECT id,space_id,key FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${row.key}`,
  )[0]
  const mayAdopt = taskRowMayAdopt(row)
  const decision = mirrorCollisionDecision(
    { id: row.id, spaceId: identity.spaceId, naturalKey: `task ${row.key}` },
    selectedMirrorIdentity(existing, (selected) => `task ${selected.key}`),
    'update',
    'natural-key',
    null,
    mayAdopt,
    selectedMirrorIdentity(keyHolder, (selected) => `task ${selected.key}`),
  )
  applyMirrorDecision(decision)
  const parentId = await taskIdFor(tx, identity.spaceId, row.parent_key, row.parent_id)
  if (decision.action === 'adopt' || decision.action === 'update-same-row') {
    const targetId = decision.action === 'adopt' ? decision.id : row.id
    const previousKey = decision.action === 'adopt' ? keyHolder!.key : existing!.key
    const changed = rows<{ id: string }>(
      await tx`UPDATE hub_task SET
      project_name=${row.project_name},key=${row.key},project=${row.project},title=${row.title},
      status=${row.status},status_category=${row.status_category},parent_key=${row.parent_key},parent_id=${parentId}::uuid,
      body=${row.body},assignee=${row.assignee},opened_at=${row.opened_at}::timestamptz,
      closed_at=${row.closed_at}::timestamptz,source=${row.source},
      first_seen=${row.first_seen}::timestamptz,last_seen=${row.last_seen}::timestamptz,
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${targetId}::uuid AND space_id=${identity.spaceId}::uuid AND
        (${row.source}='local' OR (source <> 'local' AND (${row.source} <> 'git' OR source='git')))
      RETURNING id`,
    )
    if (changed.length)
      await repairHostedTaskReferences(
        tx,
        identity.spaceId,
        targetId,
        previousKey,
        row.key,
        row.updated_at,
      )
    return decision.action === 'adopt' ? taskMirrorAdoption(row, targetId) : null
  }
  const changed = rows<{ id: string }>(
    await tx`INSERT INTO hub_task
    (id,space_id,project_name,key,project,title,status,status_category,parent_key,parent_id,body,assignee,
     opened_at,closed_at,source,first_seen,last_seen,created_at,updated_at,deleted_at)
    VALUES (${row.id || newRecordId()}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.key},${row.project},${row.title},${row.status},${row.status_category},${row.parent_key},${parentId}::uuid,${row.body},${row.assignee},${row.opened_at}::timestamptz,${row.closed_at}::timestamptz,${row.source},${row.first_seen}::timestamptz,${row.last_seen}::timestamptz,${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
    ON CONFLICT (space_id,key) DO UPDATE SET project_name=excluded.project_name,project=excluded.project,title=excluded.title,status=excluded.status,status_category=excluded.status_category,parent_key=excluded.parent_key,parent_id=excluded.parent_id,body=excluded.body,assignee=excluded.assignee,opened_at=excluded.opened_at,closed_at=excluded.closed_at,source=excluded.source,first_seen=excluded.first_seen,last_seen=excluded.last_seen,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at
    WHERE (hub_task.id=excluded.id OR ${mayAdopt}) AND
      (excluded.source='local' OR (hub_task.source <> 'local' AND (excluded.source <> 'git' OR hub_task.source='git')))
    RETURNING id`,
  )
  if (changed[0] && changed[0].id !== row.id) return taskMirrorAdoption(row, changed[0].id)
  if (!changed.length) {
    const collision = rows<{ id: string; space_id: string; key: string }>(
      await tx`SELECT id,space_id,key FROM hub_task
        WHERE space_id=${identity.spaceId}::uuid AND key=${row.key}`,
    )[0]
    const collisionDecision = mirrorCollisionDecision(
      { id: row.id, spaceId: identity.spaceId, naturalKey: `task ${row.key}` },
      null,
      'update',
      'natural-key',
      null,
      mayAdopt,
      selectedMirrorIdentity(collision, (selected) => `task ${selected.key}`),
    )
    applyMirrorDecision(collisionDecision)
    if (collisionDecision.action === 'adopt') return taskMirrorAdoption(row, collisionDecision.id)
  }
  return null
}

async function mirrorCommentRow(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedComment,
): Promise<MirrorAdoption | null> {
  const taskId = await taskIdFor(tx, identity.spaceId, row.task_key, row.task_id)
  const existing = rows<{ id: string; space_id: string; legacy_local_id: number | null }>(
    await tx`SELECT id,space_id,legacy_local_id FROM hub_task_comment WHERE id=${row.id}::uuid`,
  )[0]
  const legacyLocalIdHolder =
    !existing && row.legacy_local_id !== null
      ? rows<{ id: string; space_id: string }>(
          await tx`SELECT id,space_id FROM hub_task_comment
            WHERE space_id=${identity.spaceId}::uuid AND legacy_local_id=${row.legacy_local_id}`,
        )[0]
      : undefined
  const decision = mirrorCollisionDecision(
    {
      id: row.id,
      spaceId: identity.spaceId,
      naturalKey: localMirrorNaturalKey('comment', row.legacy_local_id),
    },
    selectedMirrorIdentity(existing, (selected) =>
      localMirrorNaturalKey('comment', selected.legacy_local_id),
    ),
    'update',
    'id',
    legacyLocalIdHolder
      ? {
          id: legacyLocalIdHolder.id,
          spaceId: legacyLocalIdHolder.space_id,
          legacyLocalId: row.legacy_local_id!,
        }
      : null,
    row.newly_assigned,
  )
  applyMirrorDecision(decision)
  if (decision.action === 'update-same-row' || decision.action === 'adopt') {
    const id = decision.action === 'adopt' ? decision.id : row.id
    await tx`UPDATE hub_task_comment SET
      legacy_local_id=COALESCE(legacy_local_id,${row.legacy_local_id}),task_key=${row.task_key},task_id=${taskId}::uuid,body=${row.body},
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${id}::uuid`
    return decision.action === 'adopt'
      ? { table: 'task_comment', legacy_local_id: row.legacy_local_id!, id }
      : null
  }
  await tx`INSERT INTO hub_task_comment
    (id,legacy_local_id,space_id,project_name,task_key,task_id,body,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.project_name},${row.task_key},${taskId}::uuid,${row.body},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)`
  return null
}

async function mirrorDocumentRow(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedDocument,
): Promise<MirrorAdoption | null> {
  const taskId = await taskIdFor(tx, identity.spaceId, row.task_key, row.task_id)
  const existing = rows<{ id: string; space_id: string; legacy_local_id: number | null }>(
    await tx`SELECT id,space_id,legacy_local_id FROM hub_task_document WHERE id=${row.id}::uuid`,
  )[0]
  const legacyLocalIdHolder =
    !existing && row.legacy_local_id !== null
      ? rows<{ id: string; space_id: string }>(
          await tx`SELECT id,space_id FROM hub_task_document
            WHERE space_id=${identity.spaceId}::uuid AND legacy_local_id=${row.legacy_local_id}`,
        )[0]
      : undefined
  const decision = mirrorCollisionDecision(
    {
      id: row.id,
      spaceId: identity.spaceId,
      naturalKey: localMirrorNaturalKey('document', row.legacy_local_id),
    },
    selectedMirrorIdentity(existing, (selected) =>
      localMirrorNaturalKey('document', selected.legacy_local_id),
    ),
    'update',
    'id',
    legacyLocalIdHolder
      ? {
          id: legacyLocalIdHolder.id,
          spaceId: legacyLocalIdHolder.space_id,
          legacyLocalId: row.legacy_local_id!,
        }
      : null,
    row.newly_assigned,
  )
  applyMirrorDecision(decision)
  if (decision.action === 'update-same-row' || decision.action === 'adopt') {
    const id = decision.action === 'adopt' ? decision.id : row.id
    await tx`UPDATE hub_task_document SET
      legacy_local_id=COALESCE(legacy_local_id,${row.legacy_local_id}),task_key=${row.task_key},task_id=${taskId}::uuid,role=${row.role},
      title=${row.title},body=${row.body},version=${row.version},
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${id}::uuid`
    return decision.action === 'adopt'
      ? { table: 'task_document', legacy_local_id: row.legacy_local_id!, id }
      : null
  }
  await tx`INSERT INTO hub_task_document
    (id,legacy_local_id,space_id,project_name,task_key,task_id,role,title,body,version,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.project_name},${row.task_key},${taskId}::uuid,${row.role},${row.title},${row.body},${row.version},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)`
  return null
}

async function mirrorStatusEventRow(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedStatusEvent,
): Promise<MirrorAdoption | null> {
  const taskId = await taskIdFor(tx, identity.spaceId, row.task_key, row.task_id)
  const existing = rows<{ id: string; space_id: string; legacy_local_id: number | null }>(
    await tx`SELECT id,space_id,legacy_local_id FROM hub_task_status_event WHERE id=${row.id}::uuid`,
  )[0]
  const legacyLocalIdHolder =
    !existing && row.legacy_local_id !== null
      ? rows<{ id: string; space_id: string }>(
          await tx`SELECT id,space_id FROM hub_task_status_event
            WHERE space_id=${identity.spaceId}::uuid AND legacy_local_id=${row.legacy_local_id}`,
        )[0]
      : undefined
  const naturalKeyHolder =
    !existing && !legacyLocalIdHolder
      ? await statusEventNaturalKeyHolder(tx, identity, row)
      : undefined
  const decision = mirrorCollisionDecision(
    {
      id: row.id,
      spaceId: identity.spaceId,
      naturalKey: localMirrorNaturalKey('status event', row.legacy_local_id),
    },
    selectedMirrorIdentity(existing, (selected) =>
      localMirrorNaturalKey('status event', selected.legacy_local_id),
    ),
    'idempotent',
    'status-event',
    legacyLocalIdHolder
      ? {
          id: legacyLocalIdHolder.id,
          spaceId: legacyLocalIdHolder.space_id,
          legacyLocalId: row.legacy_local_id!,
        }
      : null,
    row.newly_assigned,
    selectedMirrorIdentity(naturalKeyHolder, () => statusEventMirrorNaturalKey(row)),
  )
  applyMirrorDecision(decision)
  if (decision.action === 'idempotent-duplicate' || decision.action === 'adopt')
    return updateMirroredStatusEvent(tx, row, taskId, decision, naturalKeyHolder)
  await tx`INSERT INTO hub_task_status_event
    (id,legacy_local_id,space_id,project_name,task_key,task_id,at,from_status,to_status,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.project_name},${row.task_key},${taskId}::uuid,${row.at}::timestamptz,${row.from_status},${row.to_status},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)`
  return null
}

async function mirrorTaskRows(tx: SQL, identity: TaskIdentity, body: MirrorBody) {
  const adoptions: MirrorAdoption[] = []
  const taskIds = new Map<string, string>()
  for (const row of body.tasks) {
    const adoption = await mirrorTaskRow(tx, identity, row)
    if (adoption) adoptions.push(adoption)
    taskIds.set(row.key, adoption?.id ?? row.id)
  }
  return { adoptions, taskIds }
}

async function repairMirroredTaskParents(
  tx: SQL,
  identity: TaskIdentity,
  tasks: HostedTask[],
  taskIds: ReadonlyMap<string, string>,
) {
  for (const row of tasks) {
    const parentId = await taskIdFor(tx, identity.spaceId, row.parent_key, row.parent_id)
    const parent = hostedTaskRelationship('hub_task')
    await tx`UPDATE hub_task SET ${tx.unsafe(parent.idColumn)}=${parentId}::uuid
        WHERE id=${taskIds.get(row.key)!}::uuid AND space_id=${identity.spaceId}::uuid
          AND ${tx.unsafe(parent.keyColumn)} IS NOT DISTINCT FROM ${row.parent_key}`
  }
}

async function mirrorTaskChildren(tx: SQL, identity: TaskIdentity, body: MirrorBody) {
  const adoptions: MirrorAdoption[] = []
  for (const row of body.comments ?? []) {
    const adoption = await mirrorCommentRow(tx, identity, row)
    if (adoption) adoptions.push(adoption)
  }
  for (const row of body.documents ?? []) {
    const adoption = await mirrorDocumentRow(tx, identity, row)
    if (adoption) adoptions.push(adoption)
  }
  for (const row of body.statusEvents ?? []) {
    const adoption = await mirrorStatusEventRow(tx, identity, row)
    if (adoption) adoptions.push(adoption)
  }
  return adoptions
}

async function raiseMirroredSequences(tx: SQL, identity: TaskIdentity, body: MirrorBody) {
  for (const sequence of body.raiseSequences ?? []) {
    const project = rows<{ id: string }>(
      await tx`SELECT id FROM project WHERE space_id=${identity.spaceId}::uuid AND name=${sequence.project}`,
    )[0]
    if (project)
      await tx`INSERT INTO seq(space_id,project_id,name,next)
        VALUES (${identity.spaceId}::uuid,${project.id}::uuid,${`task:${sequence.prefix}`},${sequence.next})
        ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
  }
}

async function mirrorHostedTaskBody(
  tx: SQL,
  identity: TaskIdentity,
  body: MirrorBody,
  total: number,
) {
  const { adoptions, taskIds } = await mirrorTaskRows(tx, identity, body)
  await repairMirroredTaskParents(tx, identity, body.tasks, taskIds)
  adoptions.push(...(await mirrorTaskChildren(tx, identity, body)))
  await raiseMirroredSequences(tx, identity, body)
  return { upserted: total, adoptions }
}

export async function mirrorHostedTasks(url: string, identity: TaskIdentity, body: MirrorBody) {
  assertMirrorExpectedSpace(body.expectedSpaceId, identity.spaceId)
  const total =
    body.tasks.length +
    (body.comments?.length ?? 0) +
    (body.documents?.length ?? 0) +
    (body.statusEvents?.length ?? 0)
  if (total > 500) throw new Error('mirror accepts at most 500 rows')
  return withHostedTenant(url, identity, (tx) => mirrorHostedTaskBody(tx, identity, body, total))
}

export async function hostedTaskCounts(url: string, identity: TaskIdentity) {
  return withHostedTenant(url, identity, async (tx) => ({
    task: rows<{ source: string; count: number }>(
      await tx`SELECT source,count(*)::int count FROM hub_task WHERE space_id=${identity.spaceId}::uuid AND deleted_at IS NULL GROUP BY source ORDER BY source`,
    ),
    task_comment: rows<{ source: string; count: number }>(
      await tx`SELECT t.source,count(*)::int count FROM hub_task_comment c JOIN hub_task t ON ${hostedTaskJoin(tx, 'hub_task_comment', 'c')} WHERE c.space_id=${identity.spaceId}::uuid AND c.deleted_at IS NULL GROUP BY t.source ORDER BY t.source`,
    ),
    task_document: rows<{ source: string; count: number }>(
      await tx`SELECT t.source,count(*)::int count FROM hub_task_document d JOIN hub_task t ON ${hostedTaskJoin(tx, 'hub_task_document', 'd')} WHERE d.space_id=${identity.spaceId}::uuid AND d.deleted_at IS NULL GROUP BY t.source ORDER BY t.source`,
    ),
    task_status_event: rows<{ source: string; count: number }>(
      await tx`SELECT t.source,count(*)::int count FROM hub_task_status_event e JOIN hub_task t ON ${hostedTaskJoin(tx, 'hub_task_status_event', 'e')} WHERE e.space_id=${identity.spaceId}::uuid AND e.deleted_at IS NULL GROUP BY t.source ORDER BY t.source`,
    ),
  }))
}
