// concern: record-subjects
/** Owns tenant-bound hosted subject reads and writes. */

import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { MISSING_PROJECT_ID_REMEDY } from '../../../shared/record-project-identity.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'
import {
  SubjectDefinitionSchema,
  type SubjectOutput,
  subjectState,
} from '../../../shared/subjects.ts'
import { type RecordCursor, type RecordCursorRow, recordCursorAt } from './record-cursor.ts'
import { recordPool } from './record-pool.ts'
import {
  resolveRecordProjectByName,
  resolveRecordProjectIdentity,
} from './record-project-identity.ts'

export type RecordSubject = SubjectOutput & RecordCursorRow

export class RecordSubjectError extends Error {
  status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

type Tenant = { url: string } & TenantPrincipal

const missingProject = (project: string) =>
  new RecordSubjectError(
    `project "${project}" is not present in this record space; cleared by: ${PLATFORM_SLUG} project list`,
    404,
  )

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return use(tx)
  })
}

function mapped(row: Record<string, unknown>): RecordSubject {
  const updatedAt = recordIso(row.updated_at)
  return {
    id: String(row.id),
    project: String(row.project),
    name: String(row.name),
    definition: String(row.definition),
    position: Number(row.position),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    retiredAt: row.retired_at == null ? null : recordIso(row.retired_at),
    state: subjectState(row.retired_at == null ? null : recordIso(row.retired_at)),
    createdAt: recordIso(row.created_at),
    updatedAt,
    [recordCursorAt]: row.cursor_at == null ? updatedAt : String(row.cursor_at),
  }
}

export { mapped as mapRecordSubjectRow }

export async function recordSubjectRows(
  tx: SQL,
  input:
    | { ids: readonly string[] }
    | {
        spaceId: string
        projectId: string | null
        includeRetired: boolean
        order: 'catalog' | 'updated'
        cursor?: RecordCursor | null
        limit: number
      },
): Promise<Record<string, unknown>[]> {
  const from = `SELECT s.*,p.name AS project,
      to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM subject s JOIN project p ON p.space_id=s.space_id AND p.id=s.project_id`
  if ('ids' in input)
    return tx.unsafe(
      `${from} WHERE s.id=ANY(string_to_array($1, ',')::uuid[])
       ORDER BY s.updated_at,s.id LIMIT $2`,
      [input.ids.join(','), input.ids.length],
    ) as Promise<Record<string, unknown>[]>
  return tx.unsafe(
    `${from} WHERE s.space_id=$1::uuid
      AND ($2::uuid IS NULL OR p.id=$2::uuid)
      AND ($3::boolean OR s.retired_at IS NULL)
      AND ($4::timestamptz IS NULL OR (s.updated_at,s.id)>($4::timestamptz,$5::uuid))
     ORDER BY CASE WHEN $6::boolean THEN s.updated_at END,
       CASE WHEN $6::boolean THEN s.id END,
       CASE WHEN NOT $6::boolean THEN s.position END,s.id LIMIT $7`,
    [
      input.spaceId,
      input.projectId,
      input.includeRetired,
      input.cursor?.at ?? null,
      input.cursor?.id ?? null,
      input.order === 'updated',
      input.limit,
    ],
  ) as Promise<Record<string, unknown>[]>
}

async function projectId(
  tx: SQL,
  spaceId: string,
  project: string,
  requestedId?: string | null,
): Promise<string> {
  if (!requestedId)
    throw new RecordSubjectError(
      `project-scoped subject write is missing projectId; ${MISSING_PROJECT_ID_REMEDY}`,
      400,
    )
  const resolved = await resolveRecordProjectIdentity(tx, {
    projectId: requestedId,
    projectName: project,
    spaceId,
  })
  if (resolved.status !== 'found') throw missingProject(project)
  return resolved.project.id
}

async function readProjectId(
  tx: SQL,
  input: { spaceId: string; project: string; projectId?: string | null },
): Promise<string> {
  if (input.projectId) return projectId(tx, input.spaceId, input.project, input.projectId)
  const resolved = await resolveRecordProjectByName(tx, {
    spaceId: input.spaceId,
    projectName: input.project,
  })
  if (resolved.status === 'absent') throw missingProject(input.project)
  return resolved.projectId
}

async function assertParent(
  tx: SQL,
  input: { spaceId: string; projectId: string; id: string; parentId: string | null },
): Promise<void> {
  if (input.parentId === null) return
  if (input.parentId === input.id) throw new RecordSubjectError('a subject cannot parent itself')
  const parent = await tx`
    SELECT id FROM subject
    WHERE space_id=${input.spaceId}::uuid AND project_id=${input.projectId}::uuid
      AND id=${input.parentId}::uuid
  `
  if (!parent.length)
    throw new RecordSubjectError('a subject parent must belong to the same project')
  const cycle = await tx`
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM subject WHERE id=${input.parentId}::uuid
      UNION ALL
      SELECT s.id,s.parent_id FROM subject s JOIN ancestors a ON s.id=a.parent_id
    ) SELECT 1 FROM ancestors WHERE id=${input.id}::uuid LIMIT 1
  `
  if (cycle.length) throw new RecordSubjectError('a subject parent would create a cycle')
}

export async function listRecordSubjects(
  input: Tenant & {
    project?: string
    projectId?: string | null
    includeRetired: boolean
    order: 'catalog' | 'updated'
    cursor?: RecordCursor | null
    limit: number
  },
): Promise<RecordSubject[]> {
  return tenant(input, async (tx) => {
    const selectedProjectId = input.project
      ? await readProjectId(tx, {
          spaceId: input.spaceId,
          project: input.project,
          projectId: input.projectId,
        })
      : null
    const rows = await recordSubjectRows(tx, { ...input, projectId: selectedProjectId })
    return rows.map((row: Record<string, unknown>) => mapped(row))
  })
}

export async function addRecordSubject(
  input: Tenant & {
    id?: string
    project: string
    projectId?: string | null
    name: string
    definition: string
  },
): Promise<RecordSubject> {
  const definition = SubjectDefinitionSchema.parse(input.definition)
  return tenant(input, async (tx) => {
    const timestamp = new Date().toISOString()
    const ownedProjectId = await projectId(tx, input.spaceId, input.project, input.projectId)
    const id = input.id ?? newRecordId()
    await assertParent(tx, {
      spaceId: input.spaceId,
      projectId: ownedProjectId,
      id,
      parentId: null,
    })
    try {
      const rows = await tx`
        INSERT INTO subject
          (id,space_id,project_id,name,definition,position,parent_id,retired_at,created_at,updated_at)
        VALUES (${id}::uuid,${input.spaceId}::uuid,${ownedProjectId}::uuid,${input.name},
          ${definition},
          (SELECT COALESCE(MAX(position),-1)+1 FROM subject
           WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
             AND retired_at IS NULL),
          NULL,NULL,${timestamp}::timestamptz,${timestamp}::timestamptz)
        RETURNING *,${input.project} AS project
      `
      return mapped(rows[0] as Record<string, unknown>)
    } catch (error) {
      if (String(error).includes('subject_live_name')) {
        throw new RecordSubjectError(
          `subject "${input.name}" already exists in project ${input.project}; cleared by: ${PLATFORM_SLUG} doc subject list ${input.project}`,
          409,
        )
      }
      throw error
    }
  })
}

async function updateRecordSubject(
  input: Tenant & {
    project: string
    projectId?: string | null
    id: string
    field: 'name' | 'definition'
    value: string
  },
): Promise<RecordSubject> {
  const value =
    input.field === 'definition' ? SubjectDefinitionSchema.parse(input.value) : input.value
  return tenant(input, async (tx) => {
    const timestamp = new Date().toISOString()
    const ownedProjectId = await projectId(tx, input.spaceId, input.project, input.projectId)
    let rows: Record<string, unknown>[] = []
    try {
      rows =
        input.field === 'name'
          ? await tx`UPDATE subject SET name=${value},updated_at=${timestamp}::timestamptz
              WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
                AND id=${input.id}::uuid RETURNING *,${input.project} AS project`
          : await tx`UPDATE subject SET definition=${value},updated_at=${timestamp}::timestamptz
              WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
                AND id=${input.id}::uuid RETURNING *,${input.project} AS project`
    } catch (error) {
      if (String(error).includes('subject_live_name')) {
        throw new RecordSubjectError(
          `subject "${input.value}" already exists in project ${input.project}; cleared by: ${PLATFORM_SLUG} doc subject list ${input.project}`,
          409,
        )
      }
      throw error
    }
    if (!rows.length) throw unknownSubject(input.project, input.id)
    return mapped(rows[0] as Record<string, unknown>)
  })
}

const unknownSubject = (project: string, id: string) =>
  new RecordSubjectError(
    `subject "${id}" is not in project ${project}; cleared by: ${PLATFORM_SLUG} doc subject list ${project}`,
    404,
  )

export const renameRecordSubject = (
  input: Tenant & { project: string; projectId?: string | null; id: string; name: string },
) => updateRecordSubject({ ...input, field: 'name', value: input.name })

export const defineRecordSubject = (
  input: Tenant & { project: string; projectId?: string | null; id: string; definition: string },
) => updateRecordSubject({ ...input, field: 'definition', value: input.definition })

export async function reorderRecordSubjects(
  input: Tenant & { project: string; projectId?: string | null; ids: string[] },
): Promise<RecordSubject[]> {
  return tenant(input, async (tx) => {
    const timestamp = new Date().toISOString()
    const ownedProjectId = await projectId(tx, input.spaceId, input.project, input.projectId)
    const current = await tx`
      SELECT id FROM subject WHERE space_id=${input.spaceId}::uuid
        AND project_id=${ownedProjectId}::uuid AND retired_at IS NULL ORDER BY position,id
    `
    const expected = current.map((row: Record<string, unknown>) => String(row.id)).sort()
    const supplied = [...new Set(input.ids)].sort()
    if (
      input.ids.length !== supplied.length ||
      JSON.stringify(expected) !== JSON.stringify(supplied)
    ) {
      throw new RecordSubjectError(
        `reorder must name every non-retired subject in project ${input.project} exactly once; cleared by: ${PLATFORM_SLUG} doc subject list ${input.project}`,
      )
    }
    for (const [position, id] of input.ids.entries()) {
      await tx`UPDATE subject SET position=${position},updated_at=${timestamp}::timestamptz
        WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid AND id=${id}::uuid`
    }
    const rows = await tx`
      SELECT s.*,${input.project} AS project FROM subject s
      WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
        AND retired_at IS NULL ORDER BY position,id
    `
    return rows.map((row: Record<string, unknown>) => mapped(row))
  })
}

export async function retireRecordSubject(
  input: Tenant & { project: string; projectId?: string | null; id: string },
): Promise<RecordSubject> {
  return tenant(input, async (tx) => {
    const timestamp = new Date().toISOString()
    const ownedProjectId = await projectId(tx, input.spaceId, input.project, input.projectId)
    const rows = await tx`
      UPDATE subject SET retired_at=COALESCE(retired_at,${timestamp}::timestamptz),
        updated_at=${timestamp}::timestamptz
      WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
        AND id=${input.id}::uuid RETURNING *,${input.project} AS project
    `
    if (!rows.length) throw unknownSubject(input.project, input.id)
    return mapped(rows[0] as Record<string, unknown>)
  })
}
