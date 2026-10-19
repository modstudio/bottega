import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { MISSING_PROJECT_ID_REMEDY } from '../../shared/record-project-identity.ts'
import { storedHubProjectId } from './hosted-project-identity.ts'
import { hostedTaskReference, taskIdFor } from './hosted-task-reference.ts'
import {
  confirmCount,
  createHostedTaskInTransaction,
  type HostedTask,
  mirrorCollisionDecision,
  type TaskIdentity,
} from './hosted-tasks.ts'
import { projectHasRemoteTracker } from './hosted-write-mode.ts'
import { nextNoteNumber } from './note-number.ts'

export type HostedNote = {
  id: string
  number: number
  project: string
  project_name: string
  projectId?: string | null
  text: string
  area: string | null
  anchors: string
  sightings: number
  created_at: string
  last_seen_at: string
  stale_at: string | null
  stale_reason: string | null
  promoted_task: string | null
  promoted_task_id?: string | null
  updated_at: string
  deleted_at: string | null
}
export type HostedAcknowledgement = {
  id: string
  note_id: string
  project_name: string
  projectId?: string | null
  session_id: string
  acknowledged_at: string
  sightings: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export const hostedNotePullSerializers = {
  hub_note: (row: HostedNote) => row,
  hub_note_acknowledgement: (row: HostedAcknowledgement) => row,
} as const

const rows = <T>(value: unknown) => value as T[]
async function tenant<T>(client: SQL, identity: TaskIdentity, work: (tx: SQL) => Promise<T>) {
  return client.begin(async (tx) => {
    await bindTenant(tx, identity)
    return work(tx)
  })
}

export async function listHostedNotes(
  url: SQL,
  identity: TaskIdentity,
  filters: {
    project?: string
    stale?: boolean
    actionable?: boolean
    updatedSince?: string
    includeDeleted?: boolean
    cursor?: string
  },
) {
  return tenant(url, identity, async (tx) => {
    const since = filters.updatedSince ?? filters.cursor ?? '1970-01-01T00:00:00.000Z'
    const notes = rows<HostedNote>(
      await tx`SELECT hub_note.*,number::int number FROM hub_note
      WHERE space_id=${identity.spaceId}::uuid
      AND (${filters.project ?? null}::text IS NULL OR project=${filters.project ?? null})
      AND (${filters.stale === undefined ? null : filters.stale}::boolean IS NULL
        OR (${filters.stale ?? false} AND stale_at IS NOT NULL)
        OR (NOT ${filters.stale ?? false} AND stale_at IS NULL))
      AND (NOT ${filters.actionable ?? false} OR (stale_at IS NULL AND promoted_task IS NULL))
      AND updated_at > ${since}::timestamptz
      AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at,hub_note.number`,
    ).map(hostedNotePullSerializers.hub_note)
    const acknowledgements = rows<HostedAcknowledgement>(
      await tx`SELECT * FROM hub_note_acknowledgement
      WHERE space_id=${identity.spaceId}::uuid AND updated_at > ${since}::timestamptz
      AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL) ORDER BY updated_at,id`,
    ).map(hostedNotePullSerializers.hub_note_acknowledgement)
    const cursor = [...notes, ...acknowledgements].reduce((latest, row) => {
      const stamp = new Date(row.updated_at).toISOString()
      return stamp > latest ? stamp : latest
    }, since)
    const projectCounters = rows<{ project: string; next: string }>(
      await tx`SELECT p.name project,s.next::text next FROM seq s JOIN project p
        ON p.space_id=s.space_id AND p.id=s.project_id
        WHERE s.space_id=${identity.spaceId}::uuid AND s.name='note' ORDER BY p.name`,
    ).map((row) => ({ project: row.project, next: Number(row.next) }))
    return { notes, acknowledgements, projectCounters, cursor }
  })
}

export async function getHostedNote(url: SQL, identity: TaskIdentity, recordId: string) {
  return tenant(
    url,
    identity,
    async (tx) =>
      rows<HostedNote>(
        await tx`SELECT hub_note.*,number::int number FROM hub_note
    WHERE space_id=${identity.spaceId}::uuid AND id=${recordId}::uuid AND deleted_at IS NULL`,
      )[0] ?? null,
  )
}

async function lockNoteNumbers(tx: SQL, projectId: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:note`}, 0))`
}

export function noteMirrorCollision(
  incoming: { id: string; number: number; project: string; spaceId: string },
  existingById: { id: string; number: number; project: string; spaceId: string } | null,
  existingByNumber: { id: string; spaceId: string } | null,
) {
  const decision = mirrorCollisionDecision(
    {
      id: incoming.id,
      spaceId: incoming.spaceId,
      naturalKey: `${incoming.project}#${incoming.number}`,
    },
    existingById
      ? {
          id: existingById.id,
          spaceId: existingById.spaceId,
          naturalKey: `${existingById.project}#${existingById.number}`,
        }
      : null,
    {
      sameRow: 'update',
      naturalKey: {
        holder: existingByNumber
          ? {
              id: existingByNumber.id,
              spaceId: existingByNumber.spaceId,
              naturalKey: `${incoming.project}#${incoming.number}`,
            }
          : null,
      },
    },
  )
  return decision.action === 'refuse'
    ? {
        action: 'refuse' as const,
        reason: `${decision.reason}; inspect with ${PLATFORM_SLUG} note list`,
      }
    : decision
}

export async function createHostedNote(
  url: SQL,
  identity: TaskIdentity,
  input: {
    project: string
    projectId?: string | null
    text: string
    area?: string | null
    anchor: string
    sameAs?: string
  },
) {
  return tenant(url, identity, async (tx) => {
    if (!input.projectId)
      throw new Error(
        `project-scoped hosted note write is missing projectId; ${MISSING_PROJECT_ID_REMEDY}`,
      )
    if (input.sameAs) {
      const current = rows<HostedNote>(
        await tx`SELECT hub_note.*,project_id::text AS "projectId",number::int number
        FROM hub_note WHERE space_id=${identity.spaceId}::uuid
        AND id=${input.sameAs}::uuid AND deleted_at IS NULL FOR UPDATE`,
      )[0]
      if (!current) return null
      if (current.projectId !== input.projectId)
        throw new Error('the matching note belongs to another project')
      const anchors = JSON.stringify([...JSON.parse(current.anchors), JSON.parse(input.anchor)])
      return rows<HostedNote>(
        await tx`UPDATE hub_note SET anchors=${anchors},sightings=sightings+1,
        last_seen_at=now(),stale_at=NULL,stale_reason=NULL,updated_at=now()
        WHERE space_id=${identity.spaceId}::uuid AND project_id=${input.projectId}::uuid
        AND id=${input.sameAs}::uuid RETURNING *,number::int number`,
      )[0]!
    }
    const project = rows<{ id: string }>(
      await tx`SELECT id FROM project
      WHERE space_id=${identity.spaceId}::uuid AND id=${input.projectId}::uuid`,
    )[0]
    if (!project) throw new Error(`unknown project '${input.project}'`)
    await lockNoteNumbers(tx, project.id)
    const maxima = rows<{ highest: string; next: string }>(
      await tx`SELECT
      COALESCE((SELECT max(number) FROM hub_note WHERE space_id=${identity.spaceId}::uuid
        AND project_name=${input.project}),0)::text highest,
      COALESCE((SELECT next FROM seq WHERE space_id=${identity.spaceId}::uuid
        AND project_id=${project.id}::uuid AND name='note'),1)::text next`,
    )[0]!
    const number = nextNoteNumber(BigInt(maxima.highest), BigInt(maxima.next))
    await tx`INSERT INTO seq(space_id,project_id,name,next) VALUES
      (${identity.spaceId}::uuid,${project.id}::uuid,'note',${number + 1n})
      ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
    return rows<HostedNote>(
      await tx`INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,area,anchors,sightings,created_at,last_seen_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${input.project},${project.id}::uuid,${number},${input.project},
      ${input.text},${input.area ?? null},${`[${input.anchor}]`},1,now(),now(),now()) RETURNING *,number::int number`,
    )[0]!
  })
}

export async function promoteHostedNote(
  url: SQL,
  identity: TaskIdentity,
  recordId: string,
  input: { task?: string } = {},
  createTask = createHostedTaskInTransaction,
): Promise<{ note: HostedNote; task: HostedTask | null } | null> {
  return tenant(url, identity, async (tx) => {
    const note = rows<HostedNote>(
      await tx`SELECT hub_note.*,project_id::text AS "projectId",number::int number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
      AND id=${recordId}::uuid AND deleted_at IS NULL FOR UPDATE`,
    )[0]
    if (!note) return null
    if (!note.projectId) throw new Error('project-scoped hosted note is missing projectId')
    const noteProjectId = note.projectId
    if (note.promoted_task)
      throw new Error(
        `note ${note.project}#${note.number} is already promoted to ${note.promoted_task}`,
      )
    if (input.task !== undefined) {
      const project = rows<{ key_prefixes: string[]; tracker: { protocol?: string } | null }>(
        await tx`SELECT key_prefixes,tracker FROM project
        WHERE space_id=${identity.spaceId}::uuid AND id=${noteProjectId}::uuid`,
      )[0]
      validateHostedPromotionTaskKey(input.task, note.project, project)
    }
    const anchors = JSON.parse(note.anchors) as Array<Record<string, unknown>>
    const evidence = anchors
      .map(
        (a, i) =>
          `Sighting ${i + 1}: cwd=${a.cwd}; branch=${a.branch ?? '-'}; commit=${a.commit ?? '-'}; run=${a.run_id ?? '-'}; session=${a.session_id ?? '-'}`,
      )
      .join('\n')
    const selected = await selectPromotionTask(
      input.task,
      async (key) =>
        rows<HostedTask>(
          await tx`SELECT * FROM hub_task WHERE space_id=${identity.spaceId}::uuid AND project_id=${noteProjectId}::uuid AND key=${key}`,
        )[0] ?? null,
      () =>
        createTask(tx, identity, {
          project: note.project,
          projectId: noteProjectId,
          title: note.text,
          body: `${note.text}\n\nSIGHTINGS (${note.sightings})\n${evidence}`,
        }),
    )
    const { task } = selected
    const promoted = rows<HostedNote>(
      await tx`UPDATE hub_note SET promoted_task=${selected.key},promoted_task_id=${task?.id ?? null}::uuid,last_seen_at=now(),updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND id=${recordId}::uuid RETURNING *,number::int number`,
    )[0]!
    return { note: promoted, task }
  })
}

export function validateHostedPromotionTaskKey(
  key: string,
  projectName: string,
  project:
    | { key_prefixes: readonly string[]; tracker: { protocol?: string } | null | undefined }
    | undefined,
): void {
  if (!project || !projectHasRemoteTracker(project.tracker))
    throw new Error(`project '${projectName}' does not have a remote tracker`)
  const prefix = key.split('-', 1)[0]?.toUpperCase()
  const prefixes = project.key_prefixes.map((candidate) => candidate.toUpperCase())
  if (!prefix || !prefixes.includes(prefix))
    throw new Error(
      `task key '${key}' has the wrong prefix for project ${projectName}; expected: ${project.key_prefixes.join(', ')}`,
    )
}

export async function selectPromotionTask(
  existingKey: string | undefined,
  find: (key: string) => Promise<HostedTask | null>,
  mint: () => Promise<HostedTask>,
): Promise<{ key: string; task: HostedTask | null }> {
  if (existingKey) return { key: existingKey, task: await find(existingKey) }
  const task = await mint()
  return { key: task.key, task }
}

export async function reapHostedNotes(
  url: SQL,
  identity: TaskIdentity,
  input: {
    stale: Array<{ recordId: string; reason: string; at: string }>
    deleted: string[]
    confirmation: number
    cutoff: string
  },
) {
  return tenant(url, identity, async (tx) => {
    for (const row of input.stale)
      await tx`UPDATE hub_note SET stale_at=${row.at}::timestamptz,
      stale_reason=${row.reason},updated_at=now() WHERE space_id=${identity.spaceId}::uuid AND id=${row.recordId}::uuid
      AND stale_at IS NULL AND deleted_at IS NULL`
    const found = input.deleted.length
      ? rows<{ id: string }>(
          await tx`SELECT id FROM hub_note WHERE space_id=${identity.spaceId}::uuid
          AND id IN ${tx(input.deleted)} AND deleted_at IS NULL
          AND stale_at IS NOT NULL AND sightings=1 AND promoted_task IS NULL
          AND last_seen_at <= ${input.cutoff}::timestamptz FOR UPDATE`,
        )
      : []
    if (found.length < input.deleted.length)
      throw new Error('local cache is behind the record; the next maintenance pass will recompute')
    confirmCount(found.length, input.confirmation, 'bulk-only')
    if (found.length)
      await tx`UPDATE hub_note SET deleted_at=now(),updated_at=now() WHERE space_id=${identity.spaceId}::uuid
      AND id IN ${tx(found.map((row) => row.id))}`
    if (found.length)
      await tx`UPDATE hub_note_acknowledgement a SET deleted_at=now(),updated_at=now()
        FROM hub_note n WHERE a.space_id=${identity.spaceId}::uuid AND n.space_id=a.space_id
        AND n.id=a.note_id AND n.id IN ${tx(found.map((row) => row.id))} AND a.deleted_at IS NULL`
    return { marked: input.stale.length, deleted: found.length }
  })
}

async function mirrorOneHostedNote(tx: SQL, identity: TaskIdentity, row: HostedNote) {
  const projectId = await storedHubProjectId(tx, identity.spaceId, {
    projectId: row.projectId,
    projectName: row.project_name,
  })
  if (!projectId) throw new Error('project-scoped hosted note is missing projectId')
  await lockNoteNumbers(tx, projectId)
  const promotedReference = hostedTaskReference('hub_note', row)
  const promotedTaskId = promotedReference.key
    ? await taskIdFor(tx, identity.spaceId, promotedReference.key, promotedReference.id)
    : null
  const existingByNumber = rows<{ id: string; space_id: string }>(
    await tx`SELECT id, space_id FROM hub_note
      WHERE space_id=${identity.spaceId}::uuid AND project_id=${projectId}::uuid
      AND number=${row.number} FOR UPDATE`,
  )[0]
  const existingById = rows<{ id: string; number: number; project_name: string; space_id: string }>(
    await tx`SELECT id, number::int number, project_name, space_id FROM hub_note WHERE id=${row.id}::uuid FOR UPDATE`,
  )[0]
  const collision = noteMirrorCollision(
    { id: row.id, number: row.number, project: row.project_name, spaceId: identity.spaceId },
    existingById
      ? {
          id: existingById.id,
          number: Number(existingById.number),
          project: existingById.project_name,
          spaceId: existingById.space_id,
        }
      : null,
    existingByNumber ? { id: existingByNumber.id, spaceId: existingByNumber.space_id } : null,
  )
  if (collision.action === 'refuse') throw new Error(collision.reason)
  const written =
    collision.action === 'insert'
      ? rows<{ number: number; id: string }>(
          await tx`INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,area,anchors,sightings,created_at,last_seen_at,
       stale_at,stale_reason,promoted_task,promoted_task_id,updated_at,deleted_at)
      VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},
       ${await storedHubProjectId(tx, identity.spaceId, { projectId: row.projectId, projectName: row.project_name })}::uuid,
       ${row.number},${row.project},
       ${row.text},${row.area},${row.anchors},${row.sightings},${row.created_at}::timestamptz,
       ${row.last_seen_at}::timestamptz,${row.stale_at}::timestamptz,${row.stale_reason},${row.promoted_task},${promotedTaskId}::uuid,
       ${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
      RETURNING number::int number,id`,
        )[0]
      : rows<{ number: number; id: string }>(
          await tx`UPDATE hub_note SET project_name=${row.project_name},
       project_id=${await storedHubProjectId(tx, identity.spaceId, { projectId: row.projectId, projectName: row.project_name })}::uuid,
       project=${row.project},
       text=${row.text},area=${row.area},anchors=${row.anchors},sightings=${row.sightings},
       created_at=${row.created_at}::timestamptz,last_seen_at=${row.last_seen_at}::timestamptz,
       stale_at=${row.stale_at}::timestamptz,stale_reason=${row.stale_reason},promoted_task=${row.promoted_task},
       promoted_task_id=${promotedTaskId}::uuid,updated_at=${row.updated_at}::timestamptz,
       deleted_at=${row.deleted_at}::timestamptz
       WHERE space_id=${identity.spaceId}::uuid AND id=${row.id}::uuid
       RETURNING number::int number,id`,
        )[0]
  if (!written) throw new Error(`hosted note ${row.number} mirror wrote nothing`)
  const project = rows<{ id: string }>(
    await tx`SELECT id FROM project WHERE space_id=${identity.spaceId}::uuid AND id=${projectId}::uuid`,
  )[0]
  if (project)
    await tx`INSERT INTO seq(space_id,project_id,name,next) VALUES
      (${identity.spaceId}::uuid,${project.id}::uuid,'note',${row.number + 1})
      ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
  return written
}

export async function mirrorHostedNotes(
  url: SQL,
  identity: TaskIdentity,
  body: {
    notes: HostedNote[]
    acknowledgements?: HostedAcknowledgement[]
    raiseProjects?: Array<{ project: string; projectId?: string | null; next: number }>
  },
) {
  if (body.notes.length + (body.acknowledgements?.length ?? 0) > 500)
    throw new Error('mirror accepts at most 500 rows')
  return tenant(url, identity, async (tx) => {
    const noteIds: Array<{ number: number; id: string }> = []
    for (const row of body.notes) noteIds.push(await mirrorOneHostedNote(tx, identity, row))
    for (const row of body.acknowledgements ?? []) {
      const parent = rows<{ project_id: string }>(
        await tx`SELECT project_id FROM hub_note WHERE id=${row.note_id}::uuid`,
      )[0]
      if (!parent)
        throw new Error(`hosted note acknowledgement ${row.id} has no parent note ${row.note_id}`)
      await tx`INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at,deleted_at)
      VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},
       ${parent.project_id}::uuid,
       ${row.note_id}::uuid,
       ${row.session_id},${row.acknowledged_at}::timestamptz,${row.sightings},${row.created_at}::timestamptz,
       ${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
      ON CONFLICT(space_id,note_id,session_id) DO UPDATE SET project_name=excluded.project_name,
       project_id=excluded.project_id,acknowledged_at=excluded.acknowledged_at,
       sightings=excluded.sightings,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`
    }
    for (const item of body.raiseProjects ?? []) {
      if (!item.projectId)
        throw new Error(
          `project-scoped hosted note counter write is missing projectId; ${MISSING_PROJECT_ID_REMEDY}`,
        )
      const project = rows<{ id: string }>(
        await tx`SELECT id FROM project WHERE space_id=${identity.spaceId}::uuid AND id=${item.projectId}::uuid`,
      )[0]
      if (project) {
        await lockNoteNumbers(tx, project.id)
        const highest = rows<{ next: string }>(
          await tx`SELECT (COALESCE(max(number),0)+1)::text next FROM hub_note
            WHERE space_id=${identity.spaceId}::uuid AND project_id=${item.projectId}::uuid`,
        )[0]!.next
        await tx`INSERT INTO seq(space_id,project_id,name,next) VALUES
        (${identity.spaceId}::uuid,${project.id}::uuid,'note',${BigInt(highest) > BigInt(item.next) ? BigInt(highest) : BigInt(item.next)})
        ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
      }
    }
    return { upserted: body.notes.length + (body.acknowledgements?.length ?? 0), noteIds }
  })
}

export async function hostedNoteCounts(url: SQL, identity: TaskIdentity) {
  return tenant(url, identity, async (tx) => ({
    note: Number(
      rows<{ count: number }>(
        await tx`SELECT count(*)::int count FROM hub_note
      WHERE space_id=${identity.spaceId}::uuid AND deleted_at IS NULL`,
      )[0]!.count,
    ),
    note_acknowledgement: Number(
      rows<{ count: number }>(
        await tx`SELECT count(*)::int count FROM hub_note_acknowledgement
      WHERE space_id=${identity.spaceId}::uuid AND deleted_at IS NULL`,
      )[0]!.count,
    ),
  }))
}
