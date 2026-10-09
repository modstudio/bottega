// concern: record-subjects
/** Owns tenant-bound hosted subject reads and writes. */
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { SubjectDefinitionSchema, type SubjectOutput } from '../../../shared/subjects.ts'

export type RecordSubject = SubjectOutput

export class RecordSubjectError extends Error {
  status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

type Tenant = { url: string } & TenantPrincipal

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return use(tx)
    })
  } finally {
    await client.close()
  }
}

function mapped(row: Record<string, unknown>): RecordSubject {
  return {
    id: String(row.id),
    project: String(row.project),
    name: String(row.name),
    definition: String(row.definition),
    position: Number(row.position),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    retiredAt: row.retired_at == null ? null : new Date(String(row.retired_at)).toISOString(),
    state: row.retired_at == null ? 'active' : 'retired',
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }
}

async function projectId(tx: SQL, spaceId: string, project: string): Promise<string> {
  const rows = await tx`
    SELECT id FROM project WHERE space_id=${spaceId}::uuid AND name=${project}
  `
  if (!rows.length) {
    throw new RecordSubjectError(
      `project "${project}" is not present in this record space; cleared by: orch project list`,
      404,
    )
  }
  return String(rows[0]!.id)
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
    includeRetired: boolean
    order: 'catalog' | 'updated'
    cursor?: { at: string; id: string } | null
    limit: number
  },
): Promise<RecordSubject[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT s.*,p.name AS project FROM subject s
      JOIN project p ON p.space_id=s.space_id AND p.id=s.project_id
      WHERE s.space_id=${input.spaceId}::uuid
        AND (${input.project ?? null}::text IS NULL OR p.name=${input.project ?? null})
        AND (${input.includeRetired} OR s.retired_at IS NULL)
        AND (${input.cursor?.at ?? null}::timestamptz IS NULL OR
          (s.updated_at,s.id) > (${input.cursor?.at ?? null}::timestamptz,${input.cursor?.id ?? null}::uuid))
      ORDER BY CASE WHEN ${input.order === 'updated'} THEN s.updated_at END,
        CASE WHEN ${input.order === 'updated'} THEN s.id END,
        CASE WHEN ${input.order === 'catalog'} THEN s.position END,s.id
      LIMIT ${input.limit}
    `
    return rows.map((row: Record<string, unknown>) => mapped(row))
  })
}

export async function addRecordSubject(
  input: Tenant & {
    id?: string
    project: string
    name: string
    definition: string
  },
): Promise<RecordSubject> {
  SubjectDefinitionSchema.parse(input.definition)
  return tenant(input, async (tx) => {
    const ownedProjectId = await projectId(tx, input.spaceId, input.project)
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
          ${input.definition},
          (SELECT COALESCE(MAX(position),-1)+1 FROM subject
           WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
             AND retired_at IS NULL),
          NULL,NULL,now(),now())
        RETURNING *,${input.project} AS project
      `
      return mapped(rows[0] as Record<string, unknown>)
    } catch (error) {
      if (String(error).includes('subject_live_name')) {
        throw new RecordSubjectError(
          `subject "${input.name}" already exists in project ${input.project}; cleared by: orch subject list ${input.project}`,
          409,
        )
      }
      throw error
    }
  })
}

async function updateRecordSubject(
  input: Tenant & { project: string; id: string; field: 'name' | 'definition'; value: string },
): Promise<RecordSubject> {
  if (input.field === 'definition') SubjectDefinitionSchema.parse(input.value)
  return tenant(input, async (tx) => {
    const ownedProjectId = await projectId(tx, input.spaceId, input.project)
    let rows: Record<string, unknown>[] = []
    try {
      rows =
        input.field === 'name'
          ? await tx`UPDATE subject SET name=${input.value},updated_at=now()
              WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
                AND id=${input.id}::uuid RETURNING *,${input.project} AS project`
          : await tx`UPDATE subject SET definition=${input.value},updated_at=now()
              WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
                AND id=${input.id}::uuid RETURNING *,${input.project} AS project`
    } catch (error) {
      if (String(error).includes('subject_live_name')) {
        throw new RecordSubjectError(
          `subject "${input.value}" already exists in project ${input.project}; cleared by: orch subject list ${input.project}`,
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
    `subject "${id}" is not in project ${project}; cleared by: orch subject list ${project}`,
    404,
  )

export const renameRecordSubject = (
  input: Tenant & { project: string; id: string; name: string },
) => updateRecordSubject({ ...input, field: 'name', value: input.name })

export const defineRecordSubject = (
  input: Tenant & { project: string; id: string; definition: string },
) => updateRecordSubject({ ...input, field: 'definition', value: input.definition })

export async function reorderRecordSubjects(
  input: Tenant & { project: string; ids: string[] },
): Promise<RecordSubject[]> {
  return tenant(input, async (tx) => {
    const ownedProjectId = await projectId(tx, input.spaceId, input.project)
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
        `reorder must name every non-retired subject in project ${input.project} exactly once; cleared by: orch subject list ${input.project}`,
      )
    }
    for (const [position, id] of input.ids.entries()) {
      await tx`UPDATE subject SET position=${position},updated_at=now()
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
  input: Tenant & { project: string; id: string },
): Promise<RecordSubject> {
  return tenant(input, async (tx) => {
    const ownedProjectId = await projectId(tx, input.spaceId, input.project)
    const rows = await tx`
      UPDATE subject SET retired_at=COALESCE(retired_at,now()),updated_at=now()
      WHERE space_id=${input.spaceId}::uuid AND project_id=${ownedProjectId}::uuid
        AND id=${input.id}::uuid RETURNING *,${input.project} AS project
    `
    if (!rows.length) throw unknownSubject(input.project, input.id)
    return mapped(rows[0] as Record<string, unknown>)
  })
}
