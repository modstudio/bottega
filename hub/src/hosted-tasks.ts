import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../shared/record/tenant.ts'

export type TaskIdentity = TenantPrincipal
export type HostedTask = {
  id: string
  key: string
  project: string
  project_name: string
  title: string | null
  status: string | null
  status_category: string | null
  parent_key: string | null
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
  task_key: string
  project_name: string
  body: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export type HostedDocument = {
  id: string
  legacy_local_id: number | null
  task_key: string
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
  task_key: string
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
    const tasks = rows<HostedTask>(
      await tx`
      SELECT * FROM hub_task WHERE space_id=${identity.spaceId}::uuid
        AND (${filters.project ?? null}::text IS NULL OR project_name=${filters.project ?? null})
        AND (${filters.status ?? null}::text IS NULL OR status_category=${filters.status ?? null})
        AND (${filters.parent ?? null}::text IS NULL OR parent_key=${filters.parent ?? null})
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
      SELECT * FROM hub_task_comment WHERE space_id=${identity.spaceId}::uuid AND task_key=${key}
        AND deleted_at IS NULL ORDER BY created_at,id`,
    )
    const documents = rows<HostedDocument>(
      await tx`
      SELECT * FROM hub_task_document WHERE space_id=${identity.spaceId}::uuid AND task_key=${key}
        AND deleted_at IS NULL ORDER BY created_at,id`,
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
  const prefix = project?.key_prefixes[0]
  if (!project || !prefix) throw new Error(`project '${input.project}' has no key prefix`)
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
  await tx`UPDATE seq SET next=${number + 1n} WHERE space_id=${identity.spaceId}::uuid
      AND project_id=${project.id}::uuid AND name=${`task:${prefix}`}`
  const inserted = rows<HostedTask>(
    await tx`
      INSERT INTO hub_task
        (id,space_id,project_name,key,project,title,status,status_category,parent_key,body,
         opened_at,closed_at,source,first_seen,last_seen,created_at,updated_at)
      VALUES (${id}::uuid,${identity.spaceId}::uuid,${input.project},${key},${input.project},
        ${input.title},${category},${category},${input.parent ?? null},${input.body ?? null},${openedAt}::timestamptz,
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
    const updated = rows<HostedTask>(
      await tx`UPDATE hub_task SET
      title=${changes.title === undefined ? current.title : changes.title},
      status=${changes.status === undefined ? current.status : changes.status},
      status_category=${category},
      parent_key=${changes.parent_key === undefined ? current.parent_key : changes.parent_key},
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
        (id,space_id,project_name,task_key,at,from_status,to_status,created_at,updated_at)
        VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${current.project_name},${key},
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
    const project = rows<{ project_name: string }>(
      await tx`SELECT project_name FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} AND deleted_at IS NULL`,
    )[0]
    if (!project) return null
    const comment = rows<HostedComment>(
      await tx`INSERT INTO hub_task_comment
      (id,space_id,project_name,task_key,body,created_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${project.project_name},${key},${body},now(),now()) RETURNING *`,
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
    const project = rows<{ project_name: string }>(
      await tx`SELECT project_name FROM hub_task
      WHERE space_id=${identity.spaceId}::uuid AND key=${key} AND deleted_at IS NULL`,
    )[0]
    if (!project) return null
    return rows<HostedDocument>(
      await tx`INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,role,title,body,version,created_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${project.project_name},${key},
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

export function confirmSoftDelete(count: number, confirmation?: number) {
  if (count > 1 && confirmation !== count)
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
    confirmSoftDelete(found.length, confirmation)
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
  | { action: 'insert' | 'update-same-row' | 'idempotent-duplicate' }
  | { action: 'refuse'; reason: string }

export function mirrorCollisionDecision(
  incoming: MirrorIdentity,
  existing: MirrorIdentity | null,
  sameRow: 'update' | 'idempotent',
  identity: 'natural-key' | 'id' = 'natural-key',
): MirrorCollisionDecision {
  if (!existing) return { action: 'insert' }
  if (
    existing.spaceId === incoming.spaceId &&
    (identity === 'id' || existing.naturalKey === incoming.naturalKey)
  )
    return { action: sameRow === 'update' ? 'update-same-row' : 'idempotent-duplicate' }
  return {
    action: 'refuse',
    reason:
      `refusing to mirror ${incoming.naturalKey}: id ${incoming.id} already belongs to ` +
      `${existing.naturalKey} in space ${existing.spaceId}; restore this local row's record id ` +
      `to the id for ${incoming.naturalKey}, or ask the hosted-space operator to resolve the id collision`,
  }
}

function applyMirrorDecision(decision: MirrorCollisionDecision): boolean {
  if (decision.action === 'refuse') throw new Error(decision.reason)
  return decision.action !== 'idempotent-duplicate'
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

async function mirrorTaskRow(tx: SQL, identity: TaskIdentity, row: HostedTask) {
  const existing = rows<{ id: string; space_id: string; key: string }>(
    await tx`SELECT id,space_id,key FROM hub_task WHERE id=${row.id}::uuid`,
  )[0]
  applyMirrorDecision(
    mirrorCollisionDecision(
      { id: row.id, spaceId: identity.spaceId, naturalKey: `task ${row.key}` },
      selectedMirrorIdentity(existing, (selected) => `task ${selected.key}`),
      'update',
    ),
  )
  await tx`INSERT INTO hub_task
    (id,space_id,project_name,key,project,title,status,status_category,parent_key,body,assignee,
     opened_at,closed_at,source,first_seen,last_seen,created_at,updated_at,deleted_at)
    VALUES (${row.id || newRecordId()}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.key},${row.project},${row.title},${row.status},${row.status_category},${row.parent_key},${row.body},${row.assignee},${row.opened_at}::timestamptz,${row.closed_at}::timestamptz,${row.source},${row.first_seen}::timestamptz,${row.last_seen}::timestamptz,${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
    ON CONFLICT (space_id,key) DO UPDATE SET project_name=excluded.project_name,project=excluded.project,title=excluded.title,status=excluded.status,status_category=excluded.status_category,parent_key=excluded.parent_key,body=excluded.body,assignee=excluded.assignee,opened_at=excluded.opened_at,closed_at=excluded.closed_at,source=excluded.source,first_seen=excluded.first_seen,last_seen=excluded.last_seen,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at
    WHERE excluded.source='local' OR (hub_task.source <> 'local' AND (excluded.source <> 'git' OR hub_task.source='git'))`
}

async function mirrorCommentRow(tx: SQL, identity: TaskIdentity, row: HostedComment) {
  const existing = rows<{ id: string; space_id: string; legacy_local_id: number | null }>(
    await tx`SELECT id,space_id,legacy_local_id FROM hub_task_comment WHERE id=${row.id}::uuid`,
  )[0]
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
  )
  applyMirrorDecision(decision)
  if (decision.action === 'update-same-row') {
    await tx`UPDATE hub_task_comment SET
      legacy_local_id=COALESCE(legacy_local_id,${row.legacy_local_id}),body=${row.body},
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${row.id}::uuid`
    return
  }
  await tx`INSERT INTO hub_task_comment
    (id,legacy_local_id,space_id,project_name,task_key,body,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.project_name},${row.task_key},${row.body},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
    ON CONFLICT (space_id,legacy_local_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`
}

async function mirrorDocumentRow(tx: SQL, identity: TaskIdentity, row: HostedDocument) {
  const existing = rows<{ id: string; space_id: string; legacy_local_id: number | null }>(
    await tx`SELECT id,space_id,legacy_local_id FROM hub_task_document WHERE id=${row.id}::uuid`,
  )[0]
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
  )
  applyMirrorDecision(decision)
  if (decision.action === 'update-same-row') {
    await tx`UPDATE hub_task_document SET
      legacy_local_id=COALESCE(legacy_local_id,${row.legacy_local_id}),role=${row.role},
      title=${row.title},body=${row.body},version=${row.version},
      updated_at=${row.updated_at}::timestamptz,deleted_at=${row.deleted_at}::timestamptz
      WHERE id=${row.id}::uuid`
    return
  }
  await tx`INSERT INTO hub_task_document
    (id,legacy_local_id,space_id,project_name,task_key,role,title,body,version,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.project_name},${row.task_key},${row.role},${row.title},${row.body},${row.version},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
    ON CONFLICT (space_id,legacy_local_id) DO UPDATE SET role=excluded.role,title=excluded.title,body=excluded.body,version=excluded.version,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`
}

async function mirrorStatusEventRow(tx: SQL, identity: TaskIdentity, row: HostedStatusEvent) {
  const existing = rows<{ id: string; space_id: string; legacy_local_id: number | null }>(
    await tx`SELECT id,space_id,legacy_local_id FROM hub_task_status_event WHERE id=${row.id}::uuid`,
  )[0]
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
    'id',
  )
  const proceed = applyMirrorDecision(decision)
  if (
    decision.action === 'idempotent-duplicate' &&
    existing?.legacy_local_id === null &&
    row.legacy_local_id !== null
  )
    await tx`UPDATE hub_task_status_event SET legacy_local_id=${row.legacy_local_id}
      WHERE id=${row.id}::uuid AND legacy_local_id IS NULL`
  if (!proceed) return
  await tx`INSERT INTO hub_task_status_event
    (id,legacy_local_id,space_id,project_name,task_key,at,from_status,to_status,created_at,updated_at,deleted_at)
    VALUES (${row.id}::uuid,${row.legacy_local_id},${identity.spaceId}::uuid,${row.project_name},${row.task_key},${row.at}::timestamptz,${row.from_status},${row.to_status},${row.created_at}::timestamptz,${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
    ON CONFLICT (space_id,legacy_local_id) DO NOTHING`
}

export async function mirrorHostedTasks(url: string, identity: TaskIdentity, body: MirrorBody) {
  const total =
    body.tasks.length +
    (body.comments?.length ?? 0) +
    (body.documents?.length ?? 0) +
    (body.statusEvents?.length ?? 0)
  if (total > 500) throw new Error('mirror accepts at most 500 rows')
  return withHostedTenant(url, identity, async (tx) => {
    for (const row of body.tasks) await mirrorTaskRow(tx, identity, row)
    for (const row of body.comments ?? []) await mirrorCommentRow(tx, identity, row)
    for (const row of body.documents ?? []) await mirrorDocumentRow(tx, identity, row)
    for (const row of body.statusEvents ?? []) await mirrorStatusEventRow(tx, identity, row)
    for (const sequence of body.raiseSequences ?? []) {
      const project = rows<{ id: string }>(
        await tx`SELECT id FROM project WHERE space_id=${identity.spaceId}::uuid AND name=${sequence.project}`,
      )[0]
      if (project)
        await tx`INSERT INTO seq(space_id,project_id,name,next)
        VALUES (${identity.spaceId}::uuid,${project.id}::uuid,${`task:${sequence.prefix}`},${sequence.next})
        ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
    }
    return { upserted: total }
  })
}

export async function hostedTaskCounts(url: string, identity: TaskIdentity) {
  return withHostedTenant(url, identity, async (tx) => ({
    task: rows<{ source: string; count: number }>(
      await tx`SELECT source,count(*)::int count FROM hub_task WHERE space_id=${identity.spaceId}::uuid AND deleted_at IS NULL GROUP BY source ORDER BY source`,
    ),
    task_comment: rows<{ source: string; count: number }>(
      await tx`SELECT t.source,count(*)::int count FROM hub_task_comment c JOIN hub_task t ON t.space_id=c.space_id AND t.key=c.task_key WHERE c.space_id=${identity.spaceId}::uuid AND c.deleted_at IS NULL GROUP BY t.source ORDER BY t.source`,
    ),
    task_document: rows<{ source: string; count: number }>(
      await tx`SELECT t.source,count(*)::int count FROM hub_task_document d JOIN hub_task t ON t.space_id=d.space_id AND t.key=d.task_key WHERE d.space_id=${identity.spaceId}::uuid AND d.deleted_at IS NULL GROUP BY t.source ORDER BY t.source`,
    ),
    task_status_event: rows<{ source: string; count: number }>(
      await tx`SELECT t.source,count(*)::int count FROM hub_task_status_event e JOIN hub_task t ON t.space_id=e.space_id AND t.key=e.task_key WHERE e.space_id=${identity.spaceId}::uuid AND e.deleted_at IS NULL GROUP BY t.source ORDER BY t.source`,
    ),
  }))
}
