import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { hostedTaskReference, taskIdFor } from './hosted-task-reference.ts'
import {
  confirmCount,
  createHostedTaskInTransaction,
  type HostedTask,
  type TaskIdentity,
} from './hosted-tasks.ts'

export type HostedNote = {
  id: string
  number: number
  project: string
  project_name: string
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
  session_id: string
  acknowledged_at: string
  sightings: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const rows = <T>(value: unknown) => value as T[]
async function tenant<T>(url: string, identity: TaskIdentity, work: (tx: SQL) => Promise<T>) {
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

export async function listHostedNotes(
  url: string,
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
    )
    const acknowledgements = rows<HostedAcknowledgement>(
      await tx`SELECT * FROM hub_note_acknowledgement
      WHERE space_id=${identity.spaceId}::uuid AND updated_at > ${since}::timestamptz
      AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL) ORDER BY updated_at,id`,
    )
    const cursor = [...notes, ...acknowledgements].reduce((latest, row) => {
      const stamp = new Date(row.updated_at).toISOString()
      return stamp > latest ? stamp : latest
    }, since)
    return { notes, acknowledgements, cursor }
  })
}

export async function getHostedNote(url: string, identity: TaskIdentity, number: number) {
  return tenant(
    url,
    identity,
    async (tx) =>
      rows<HostedNote>(
        await tx`SELECT hub_note.*,number::int number FROM hub_note
    WHERE space_id=${identity.spaceId}::uuid AND number=${number} AND deleted_at IS NULL`,
      )[0] ?? null,
  )
}

async function lockNoteNumbers(tx: SQL, identity: TaskIdentity) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${identity.spaceId}:note`}, 0))`
}

export function nextNoteNumber(highest: bigint, sequenceNext: bigint) {
  return highest + 1n > sequenceNext ? highest + 1n : sequenceNext
}

export async function createHostedNote(
  url: string,
  identity: TaskIdentity,
  input: {
    project: string
    text: string
    area?: string | null
    anchor: string
    sameAs?: number
  },
) {
  return tenant(url, identity, async (tx) => {
    if (input.sameAs) {
      const current = rows<HostedNote>(
        await tx`SELECT hub_note.*,number::int number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
        AND number=${input.sameAs} AND deleted_at IS NULL FOR UPDATE`,
      )[0]
      if (!current) return null
      if (current.project !== input.project)
        throw new Error('the matching note belongs to another project')
      const anchors = JSON.stringify([...JSON.parse(current.anchors), JSON.parse(input.anchor)])
      return rows<HostedNote>(
        await tx`UPDATE hub_note SET anchors=${anchors},sightings=sightings+1,
        last_seen_at=now(),stale_at=NULL,stale_reason=NULL,updated_at=now()
        WHERE space_id=${identity.spaceId}::uuid AND number=${input.sameAs} RETURNING *,number::int number`,
      )[0]!
    }
    await lockNoteNumbers(tx, identity)
    const project = rows<{ id: string }>(
      await tx`SELECT id FROM project
      WHERE space_id=${identity.spaceId}::uuid AND name=${input.project}`,
    )[0]
    if (!project) throw new Error(`unknown project '${input.project}'`)
    const maxima = rows<{ highest: string; next: string }>(
      await tx`SELECT
      COALESCE((SELECT max(number) FROM hub_note WHERE space_id=${identity.spaceId}::uuid),0)::text highest,
      COALESCE((SELECT max(next) FROM seq WHERE space_id=${identity.spaceId}::uuid AND name='note'),1)::text next`,
    )[0]!
    const number = nextNoteNumber(BigInt(maxima.highest), BigInt(maxima.next))
    await tx`INSERT INTO seq(space_id,project_id,name,next) VALUES
      (${identity.spaceId}::uuid,${project.id}::uuid,'note',${number + 1n})
      ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
    return rows<HostedNote>(
      await tx`INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,area,anchors,sightings,created_at,last_seen_at,updated_at)
      VALUES (${newRecordId()}::uuid,${identity.spaceId}::uuid,${input.project},${number},${input.project},
      ${input.text},${input.area ?? null},${`[${input.anchor}]`},1,now(),now(),now()) RETURNING *,number::int number`,
    )[0]!
  })
}

export async function patchHostedNote(
  url: string,
  identity: TaskIdentity,
  number: number,
  changes: Partial<
    Pick<
      HostedNote,
      | 'text'
      | 'area'
      | 'anchors'
      | 'sightings'
      | 'last_seen_at'
      | 'stale_at'
      | 'stale_reason'
      | 'promoted_task'
    >
  >,
) {
  return tenant(url, identity, async (tx) => {
    const current = rows<HostedNote>(
      await tx`SELECT hub_note.*,number::int number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
      AND number=${number} AND deleted_at IS NULL FOR UPDATE`,
    )[0]
    if (!current) return null
    const promotedTask =
      changes.promoted_task === undefined ? current.promoted_task : changes.promoted_task
    const promotedReference = hostedTaskReference('hub_note', {
      promoted_task: promotedTask,
      promoted_task_id:
        changes.promoted_task === undefined ? (current.promoted_task_id ?? null) : null,
    })
    const promotedTaskId = promotedReference.key
      ? await taskIdFor(tx, identity.spaceId, promotedReference.key, promotedReference.id)
      : null
    return rows<HostedNote>(
      await tx`UPDATE hub_note SET text=${changes.text ?? current.text},
      area=${changes.area === undefined ? current.area : changes.area},anchors=${changes.anchors ?? current.anchors},
      sightings=${changes.sightings ?? current.sightings},last_seen_at=${changes.last_seen_at ?? current.last_seen_at}::timestamptz,
      stale_at=${changes.stale_at === undefined ? current.stale_at : changes.stale_at}::timestamptz,
      stale_reason=${changes.stale_reason === undefined ? current.stale_reason : changes.stale_reason},
      promoted_task=${promotedTask},promoted_task_id=${promotedTaskId}::uuid,updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND number=${number} RETURNING *,number::int number`,
    )[0]!
  })
}

export async function acknowledgeHostedNote(
  url: string,
  identity: TaskIdentity,
  number: number,
  session: string,
) {
  return tenant(url, identity, async (tx) => {
    const note = rows<HostedNote>(
      await tx`SELECT hub_note.*,number::int number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
      AND number=${number} AND deleted_at IS NULL`,
    )[0]
    if (!note) return null
    const old = rows<HostedAcknowledgement>(
      await tx`SELECT * FROM hub_note_acknowledgement
      WHERE space_id=${identity.spaceId}::uuid AND note_id=${note.id}::uuid AND session_id=${session}`,
    )[0]
    if (old?.sightings === note.sightings && !old.deleted_at)
      return { note, acknowledgement: old, alreadyAcknowledged: true }
    const acknowledgement = rows<HostedAcknowledgement>(
      await tx`INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
      VALUES (${old?.id ?? newRecordId()}::uuid,${identity.spaceId}::uuid,${note.project},${note.id}::uuid,${session},now(),${note.sightings},now(),now())
      ON CONFLICT(space_id,note_id,session_id) DO UPDATE SET acknowledged_at=now(),sightings=excluded.sightings,
      updated_at=now(),deleted_at=NULL RETURNING *`,
    )[0]!
    return { note, acknowledgement, alreadyAcknowledged: false }
  })
}

export async function promoteHostedNote(
  url: string,
  identity: TaskIdentity,
  number: number,
  createTask = createHostedTaskInTransaction,
): Promise<{ note: HostedNote; task: HostedTask } | null> {
  return tenant(url, identity, async (tx) => {
    const note = rows<HostedNote>(
      await tx`SELECT hub_note.*,number::int number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
      AND number=${number} AND deleted_at IS NULL FOR UPDATE`,
    )[0]
    if (!note) return null
    if (note.promoted_task)
      throw new Error(`note ${number} is already promoted to ${note.promoted_task}`)
    const anchors = JSON.parse(note.anchors) as Array<Record<string, unknown>>
    const evidence = anchors
      .map(
        (a, i) =>
          `Sighting ${i + 1}: cwd=${a.cwd}; branch=${a.branch ?? '-'}; commit=${a.commit ?? '-'}; run=${a.run_id ?? '-'}; session=${a.session_id ?? '-'}`,
      )
      .join('\n')
    const task = await createTask(tx, identity, {
      project: note.project,
      title: note.text,
      body: `${note.text}\n\nSIGHTINGS (${note.sightings})\n${evidence}`,
    })
    const promoted = rows<HostedNote>(
      await tx`UPDATE hub_note SET promoted_task=${task.key},promoted_task_id=${task.id}::uuid,last_seen_at=now(),updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND number=${number} RETURNING *,number::int number`,
    )[0]!
    return { note: promoted, task }
  })
}

export async function dropHostedNote(
  url: string,
  identity: TaskIdentity,
  number: number,
  reason: string,
) {
  return patchHostedNote(url, identity, number, {
    stale_at: new Date().toISOString(),
    stale_reason: `dropped: ${reason}`,
    last_seen_at: new Date().toISOString(),
  })
}

export async function mergeHostedNotes(
  url: string,
  identity: TaskIdentity,
  targetNumber: number,
  sourceNumber: number,
) {
  return tenant(url, identity, async (tx) => {
    const found = rows<HostedNote>(
      await tx`SELECT hub_note.*,number::int number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
      AND number IN (${targetNumber},${sourceNumber}) AND deleted_at IS NULL FOR UPDATE`,
    )
    const target = found.find((n) => Number(n.number) === targetNumber),
      source = found.find((n) => Number(n.number) === sourceNumber)
    if (!target || !source) return null
    if (target.project !== source.project)
      throw new Error('notes from different projects cannot be merged')
    const updated = rows<HostedNote>(
      await tx`UPDATE hub_note SET anchors=${JSON.stringify([...JSON.parse(target.anchors), ...JSON.parse(source.anchors)])},
      sightings=${target.sightings + source.sightings},last_seen_at=${target.last_seen_at > source.last_seen_at ? target.last_seen_at : source.last_seen_at}::timestamptz,updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND number=${targetNumber} RETURNING *,number::int number`,
    )[0]!
    await tx`UPDATE hub_note SET deleted_at=now(),updated_at=now() WHERE space_id=${identity.spaceId}::uuid AND number=${sourceNumber}`
    await tx`UPDATE hub_note_acknowledgement SET deleted_at=now(),updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND note_id=${source.id}::uuid AND deleted_at IS NULL`
    return { note: updated, deleted: sourceNumber }
  })
}

export async function reapHostedNotes(
  url: string,
  identity: TaskIdentity,
  input: {
    stale: Array<{ number: number; reason: string; at: string }>
    deleted: number[]
    confirmation: number
    cutoff: string
  },
) {
  return tenant(url, identity, async (tx) => {
    for (const row of input.stale)
      await tx`UPDATE hub_note SET stale_at=${row.at}::timestamptz,
      stale_reason=${row.reason},updated_at=now() WHERE space_id=${identity.spaceId}::uuid AND number=${row.number}
      AND stale_at IS NULL AND deleted_at IS NULL`
    const found = input.deleted.length
      ? rows<{ number: number }>(
          await tx`SELECT number FROM hub_note WHERE space_id=${identity.spaceId}::uuid
          AND number IN ${tx(input.deleted)} AND deleted_at IS NULL
          AND stale_at IS NOT NULL AND sightings=1 AND promoted_task IS NULL
          AND last_seen_at <= ${input.cutoff}::timestamptz FOR UPDATE`,
        )
      : []
    if (found.length < input.deleted.length)
      throw new Error('local cache is behind the record; the next maintenance pass will recompute')
    confirmCount(found.length, input.confirmation, 'bulk-only')
    if (found.length)
      await tx`UPDATE hub_note SET deleted_at=now(),updated_at=now() WHERE space_id=${identity.spaceId}::uuid
      AND number IN ${tx(found.map((row) => row.number))}`
    if (found.length)
      await tx`UPDATE hub_note_acknowledgement a SET deleted_at=now(),updated_at=now()
        FROM hub_note n WHERE a.space_id=${identity.spaceId}::uuid AND n.space_id=a.space_id
        AND n.id=a.note_id AND n.number IN ${tx(found.map((row) => row.number))} AND a.deleted_at IS NULL`
    return { marked: input.stale.length, deleted: found.length }
  })
}

export async function mirrorHostedNotes(
  url: string,
  identity: TaskIdentity,
  body: {
    notes: HostedNote[]
    acknowledgements?: HostedAcknowledgement[]
    raiseProjects?: Array<{ project: string; next: number }>
  },
) {
  if (body.notes.length + (body.acknowledgements?.length ?? 0) > 500)
    throw new Error('mirror accepts at most 500 rows')
  return tenant(url, identity, async (tx) => {
    await lockNoteNumbers(tx, identity)
    const noteIds: Array<{ number: number; id: string }> = []
    for (const row of body.notes) {
      const promotedReference = hostedTaskReference('hub_note', row)
      const promotedTaskId = promotedReference.key
        ? await taskIdFor(tx, identity.spaceId, promotedReference.key, promotedReference.id)
        : null
      const inserted = rows<{ number: number; id: string }>(
        await tx`INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,area,anchors,sightings,created_at,last_seen_at,
       stale_at,stale_reason,promoted_task,promoted_task_id,updated_at,deleted_at)
      VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.number},${row.project},
       ${row.text},${row.area},${row.anchors},${row.sightings},${row.created_at}::timestamptz,
       ${row.last_seen_at}::timestamptz,${row.stale_at}::timestamptz,${row.stale_reason},${row.promoted_task},${promotedTaskId}::uuid,
       ${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
      ON CONFLICT(space_id,number) DO UPDATE SET project_name=excluded.project_name,project=excluded.project,
       text=excluded.text,area=excluded.area,anchors=excluded.anchors,sightings=excluded.sightings,
       created_at=excluded.created_at,last_seen_at=excluded.last_seen_at,stale_at=excluded.stale_at,
       stale_reason=excluded.stale_reason,promoted_task=excluded.promoted_task,
       promoted_task_id=excluded.promoted_task_id,updated_at=excluded.updated_at,
       deleted_at=excluded.deleted_at RETURNING number::int number,id`,
      )[0]!
      noteIds.push(inserted)
    }
    for (const row of body.acknowledgements ?? [])
      await tx`INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,note_id,session_id,acknowledged_at,sightings,created_at,updated_at,deleted_at)
      VALUES (${row.id}::uuid,${identity.spaceId}::uuid,${row.project_name},${row.note_id}::uuid,
       ${row.session_id},${row.acknowledged_at}::timestamptz,${row.sightings},${row.created_at}::timestamptz,
       ${row.updated_at}::timestamptz,${row.deleted_at}::timestamptz)
      ON CONFLICT(space_id,note_id,session_id) DO UPDATE SET acknowledged_at=excluded.acknowledged_at,
       sightings=excluded.sightings,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`
    const highest = rows<{ next: string }>(
      await tx`SELECT (COALESCE(max(number),0)+1)::text next FROM hub_note
      WHERE space_id=${identity.spaceId}::uuid`,
    )[0]!.next
    for (const item of body.raiseProjects ?? []) {
      const project = rows<{ id: string }>(
        await tx`SELECT id FROM project WHERE space_id=${identity.spaceId}::uuid AND name=${item.project}`,
      )[0]
      if (project)
        await tx`INSERT INTO seq(space_id,project_id,name,next) VALUES
        (${identity.spaceId}::uuid,${project.id}::uuid,'note',${BigInt(highest) > BigInt(item.next) ? BigInt(highest) : BigInt(item.next)})
        ON CONFLICT(space_id,project_id,name) DO UPDATE SET next=GREATEST(seq.next,excluded.next)`
    }
    return { upserted: body.notes.length + (body.acknowledgements?.length ?? 0), noteIds }
  })
}

export async function hostedNoteCounts(url: string, identity: TaskIdentity) {
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
