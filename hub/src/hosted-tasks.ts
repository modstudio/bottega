import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../shared/record/tenant.ts'
import {
  hostedTaskJoin,
  hostedTaskRelationship,
  repairHostedTaskReferences,
  taskIdFor,
} from './hosted-task-reference.ts'
import { formatTaskDocumentLabel } from './task-document-label.ts'

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
  next_document_number: number
}
export type HostedComment = {
  id: string
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
  number: number | null
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

export const hostedTaskPullSerializers = {
  hub_task: (row: HostedTask) => row,
  hub_task_comment: (row: HostedComment) => row,
  hub_task_document: (row: HostedDocument) => row,
  hub_task_status_event: (row: HostedStatusEvent) => row,
} as const

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
    ).map(hostedTaskPullSerializers.hub_task)
    const comments = rows<HostedComment>(
      await tx`
      SELECT * FROM hub_task_comment WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
        ORDER BY updated_at,id`,
    ).map(hostedTaskPullSerializers.hub_task_comment)
    const documents = rows<HostedDocument>(
      await tx`
      SELECT * FROM hub_task_document WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
        ORDER BY updated_at,id`,
    ).map(hostedTaskPullSerializers.hub_task_document)
    const statusEvents = rows<HostedStatusEvent>(
      await tx`
      SELECT * FROM hub_task_status_event WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${since}::timestamptz
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
        ORDER BY updated_at,id`,
    ).map(hostedTaskPullSerializers.hub_task_status_event)
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
        AND d.deleted_at IS NULL ORDER BY d.number`,
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
    const project = rows<{ id: string; project_name: string; next_document_number: number }>(
      await tx`SELECT id,project_name,next_document_number FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} AND deleted_at IS NULL FOR UPDATE`,
    )[0]
    if (!project) return null
    const document = rows<HostedDocument>(
      await tx`INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,task_id,number,role,title,body,version,created_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${project.project_name},${key},${project.id}::uuid,
       ${project.next_document_number},${input.role ?? null},${input.title},${input.body ?? ''},${input.version},now(),now()) RETURNING *`,
    )[0]!
    await tx`UPDATE hub_task SET next_document_number=${project.next_document_number + 1}
      WHERE id=${project.id}::uuid`
    return document
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
  comments?: HostedComment[]
  documents?: HostedDocument[]
  statusEvents?: HostedStatusEvent[]
  raiseSequences?: Array<{ project: string; prefix: string; next: number }>
}

type MirrorIdentity = { id: string; spaceId: string; naturalKey: string }
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

export function mirrorCollisionDecision(
  incoming: MirrorIdentity,
  existing: MirrorIdentity | null,
  options: {
    sameRow: 'update' | 'idempotent'
    naturalKey?: { holder: MirrorIdentity | null; mayAdopt?: boolean }
  },
): MirrorCollisionDecision {
  if (existing && existing.spaceId !== incoming.spaceId)
    return {
      action: 'refuse',
      reason:
        `refusing to mirror ${incoming.naturalKey}: id ${incoming.id} already belongs to ` +
        `${existing.naturalKey} in space ${existing.spaceId}; restore this local row's record id ` +
        `to the id for ${incoming.naturalKey}, or ask the hosted-space operator to resolve the id collision`,
    }
  const naturalKeyCollision = options.naturalKey
    ? naturalKeyCollisionDecision(
        incoming,
        existing,
        options.naturalKey.mayAdopt ?? false,
        options.naturalKey.holder,
      )
    : null
  if (naturalKeyCollision) return naturalKeyCollision
  if (!existing) return { action: 'insert' }
  return {
    action: options.sameRow === 'update' ? 'update-same-row' : 'idempotent-duplicate',
  }
}

function applyMirrorDecision(decision: MirrorCollisionDecision): boolean {
  if (decision.action === 'refuse') throw new Error(decision.reason)
  return decision.action !== 'idempotent-duplicate' && decision.action !== 'adopt'
}

export type MirrorAdoption = {
  table: 'task'
  project: string
  key: string
  id: string
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

function statusEventMirrorNaturalKey(row: HostedStatusEvent) {
  return `status event for task ${row.task_id ?? row.task_key} to ${row.to_status} at ${row.at}`
}

type HostedStatusEventHolder = {
  id: string
  space_id: string
  task_id: string | null
}

async function statusEventNaturalKeyHolder(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedStatusEvent,
): Promise<HostedStatusEventHolder | undefined> {
  if (row.task_id)
    return rows<HostedStatusEventHolder>(
      await tx`SELECT id,space_id,task_id
        FROM hub_task_status_event
        WHERE space_id=${identity.spaceId}::uuid
          AND (task_id=${row.task_id}::uuid OR
            (task_id IS NULL AND task_key=${row.task_key}))
          AND to_status=${row.to_status} AND at=${row.at}::timestamptz`,
    )[0]
  return rows<HostedStatusEventHolder>(
    await tx`SELECT id,space_id,task_id
      FROM hub_task_status_event
      WHERE space_id=${identity.spaceId}::uuid AND task_key=${row.task_key}
        AND to_status=${row.to_status} AND at=${row.at}::timestamptz`,
  )[0]
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
    {
      sameRow: 'update',
      naturalKey: {
        holder: selectedMirrorIdentity(keyHolder, (selected) => `task ${selected.key}`),
        mayAdopt,
      },
    },
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
      first_seen=LEAST(first_seen,${row.first_seen}::timestamptz),last_seen=${row.last_seen}::timestamptz,
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz,
      next_document_number=GREATEST(next_document_number,${row.next_document_number})
      WHERE id=${targetId}::uuid AND space_id=${identity.spaceId}::uuid AND
        (${row.source}='local' OR (source <> 'local' AND (${row.source} <> 'git' OR source='git'))) AND
        (ROW(project_name,key,project,title,status,status_category,parent_key,parent_id,body,assignee,
          opened_at,closed_at,source,updated_at,deleted_at) IS DISTINCT FROM
         ROW(${row.project_name},${row.key},${row.project},${row.title},${row.status},${row.status_category},
          ${row.parent_key},${parentId}::uuid,${row.body},${row.assignee},${row.opened_at}::timestamptz,
          ${row.closed_at}::timestamptz,${row.source},${row.updated_at}::timestamptz,
          ${row.deleted_at}::timestamptz) OR next_document_number < ${row.next_document_number})
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
     opened_at,closed_at,source,first_seen,last_seen,created_at,updated_at,deleted_at,next_document_number)
    VALUES (${row.id || newRecordId()}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.key},${row.project},${row.title},${row.status},${row.status_category},${row.parent_key},${parentId}::uuid,${row.body},${row.assignee},${row.opened_at}::timestamptz,${row.closed_at}::timestamptz,${row.source},${row.first_seen}::timestamptz,${row.last_seen}::timestamptz,${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz,${row.next_document_number})
    ON CONFLICT (space_id,key) DO UPDATE SET project_name=excluded.project_name,project=excluded.project,title=excluded.title,status=excluded.status,status_category=excluded.status_category,parent_key=excluded.parent_key,parent_id=excluded.parent_id,body=excluded.body,assignee=excluded.assignee,opened_at=excluded.opened_at,closed_at=excluded.closed_at,source=excluded.source,first_seen=LEAST(hub_task.first_seen,excluded.first_seen),last_seen=excluded.last_seen,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,next_document_number=GREATEST(hub_task.next_document_number,excluded.next_document_number)
    WHERE (hub_task.id=excluded.id OR ${mayAdopt}) AND
      (excluded.source='local' OR (hub_task.source <> 'local' AND (excluded.source <> 'git' OR hub_task.source='git'))) AND
      (ROW(hub_task.project_name,hub_task.project,hub_task.title,hub_task.status,
        hub_task.status_category,hub_task.parent_key,hub_task.parent_id,hub_task.body,hub_task.assignee,
        hub_task.opened_at,hub_task.closed_at,hub_task.source,hub_task.updated_at,hub_task.deleted_at)
       IS DISTINCT FROM ROW(excluded.project_name,excluded.project,excluded.title,excluded.status,
        excluded.status_category,excluded.parent_key,excluded.parent_id,excluded.body,excluded.assignee,
        excluded.opened_at,excluded.closed_at,excluded.source,excluded.updated_at,excluded.deleted_at)
       OR hub_task.next_document_number < excluded.next_document_number)
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
      {
        sameRow: 'update',
        naturalKey: {
          holder: selectedMirrorIdentity(collision, (selected) => `task ${selected.key}`),
          mayAdopt,
        },
      },
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
): Promise<void> {
  const taskId = await taskIdFor(tx, identity.spaceId, row.task_key, row.task_id)
  const existing = rows<{ id: string; space_id: string }>(
    await tx`SELECT id,space_id FROM hub_task_comment WHERE id=${row.id}::uuid`,
  )[0]
  const decision = mirrorCollisionDecision(
    { id: row.id, spaceId: identity.spaceId, naturalKey: `comment ${row.id}` },
    selectedMirrorIdentity(existing, () => `comment ${row.id}`),
    { sameRow: 'update' },
  )
  applyMirrorDecision(decision)
  if (decision.action === 'update-same-row') {
    await tx`UPDATE hub_task_comment SET
      task_key=${row.task_key},task_id=${taskId}::uuid,body=${row.body},
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${row.id}::uuid`
    return
  }
  await tx`INSERT INTO hub_task_comment
    (id,space_id,project_name,task_key,task_id,body,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.task_key},${taskId}::uuid,${row.body},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)`
}

async function mirrorDocumentRow(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedDocument,
): Promise<void> {
  const number = row.number
  if (!row.deleted_at && number === null)
    throw new Error(`live task document ${row.id} for task ${row.task_key} has no number`)
  const taskId = await taskIdFor(tx, identity.spaceId, row.task_key, row.task_id)
  const existing = rows<{ id: string; space_id: string }>(
    await tx`SELECT id,space_id FROM hub_task_document WHERE id=${row.id}::uuid`,
  )[0]
  const numberHolder =
    number === null
      ? null
      : rows<{ id: string }>(
          await tx`SELECT id FROM hub_task_document
          WHERE space_id=${identity.spaceId}::uuid AND task_id=${taskId}::uuid
            AND number=${number} AND id<>${row.id}::uuid`,
        )[0]
  if (numberHolder) {
    throw new Error(
      `task document number collision: ${formatTaskDocumentLabel(row.task_key, number!)} belongs to UUID ${numberHolder.id}, not incoming UUID ${row.id}; run \`hub task doc list ${row.task_key}\``,
    )
  }
  const decision = mirrorCollisionDecision(
    { id: row.id, spaceId: identity.spaceId, naturalKey: `document ${row.id}` },
    selectedMirrorIdentity(existing, () => `document ${row.id}`),
    { sameRow: 'update' },
  )
  applyMirrorDecision(decision)
  if (decision.action === 'update-same-row') {
    await tx`UPDATE hub_task_document SET
      task_key=${row.task_key},task_id=${taskId}::uuid,number=${number},role=${row.role},
      title=${row.title},body=${row.body},version=${row.version},
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${row.id}::uuid`
    if (!row.deleted_at)
      await tx`UPDATE hub_task SET next_document_number=GREATEST(next_document_number,${number! + 1})
        WHERE id=${taskId}::uuid`
    return
  }
  await tx`INSERT INTO hub_task_document
    (id,space_id,project_name,task_key,task_id,number,role,title,body,version,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.task_key},${taskId}::uuid,${number},${row.role},${row.title},${row.body},${row.version},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)`
  if (!row.deleted_at)
    await tx`UPDATE hub_task SET next_document_number=GREATEST(next_document_number,${number! + 1})
      WHERE id=${taskId}::uuid`
}

async function mirrorStatusEventRow(
  tx: SQL,
  identity: TaskIdentity,
  row: HostedStatusEvent,
): Promise<void> {
  const taskId = await taskIdFor(tx, identity.spaceId, row.task_key, row.task_id)
  const existing = rows<{ id: string; space_id: string }>(
    await tx`SELECT id,space_id FROM hub_task_status_event WHERE id=${row.id}::uuid`,
  )[0]
  const naturalKeyHolder = !existing
    ? await statusEventNaturalKeyHolder(tx, identity, row)
    : undefined
  const decision = mirrorCollisionDecision(
    { id: row.id, spaceId: identity.spaceId, naturalKey: statusEventMirrorNaturalKey(row) },
    selectedMirrorIdentity(existing, () => statusEventMirrorNaturalKey(row)),
    {
      sameRow: 'idempotent',
      naturalKey: {
        holder: selectedMirrorIdentity(naturalKeyHolder, () => statusEventMirrorNaturalKey(row)),
      },
    },
  )
  applyMirrorDecision(decision)
  if (decision.action === 'idempotent-duplicate') {
    await tx`UPDATE hub_task_status_event SET task_key=${row.task_key},task_id=${taskId}::uuid
      WHERE id=${row.id}::uuid`
    return
  }
  await tx`INSERT INTO hub_task_status_event
    (id,space_id,project_name,task_key,task_id,at,from_status,to_status,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.task_key},${taskId}::uuid,${row.at}::timestamptz,${row.from_status},${row.to_status},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)`
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
  for (const row of body.comments ?? []) await mirrorCommentRow(tx, identity, row)
  for (const row of body.documents ?? []) await mirrorDocumentRow(tx, identity, row)
  for (const row of body.statusEvents ?? []) await mirrorStatusEventRow(tx, identity, row)
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

export async function mirrorHostedTaskBody(
  tx: SQL,
  identity: TaskIdentity,
  body: MirrorBody,
  total: number,
) {
  const { adoptions, taskIds } = await mirrorTaskRows(tx, identity, body)
  await repairMirroredTaskParents(tx, identity, body.tasks, taskIds)
  await mirrorTaskChildren(tx, identity, body)
  await raiseMirroredSequences(tx, identity, body)
  return { upserted: total, adoptions }
}

export async function mirrorHostedTasks(url: string, identity: TaskIdentity, body: MirrorBody) {
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
