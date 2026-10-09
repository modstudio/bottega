// concern: subjects
/** Owns local subject storage and hosted-first subject mutations. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  SubjectDefinitionSchema,
  type SubjectOutput,
  subjectState,
} from '../../../shared/subjects.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { projectByName, projectRowByName } from '../project/projects.ts'
import type { RecordSubject } from '../record/record-subjects.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { subjectClient } from './subject-client.ts'

export type Subject = SubjectOutput

type LocalRow = {
  id: string
  project: string
  name: string
  definition: string
  position: number
  parent_id: string | null
  retired_at: string | null
  created_at: string
  updated_at: string
}

const mapped = (row: LocalRow): Subject => ({
  id: row.id,
  project: row.project,
  name: row.name,
  definition: row.definition,
  position: row.position,
  parentId: row.parent_id,
  retiredAt: row.retired_at,
  state: subjectState(row.retired_at),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const unknownProject = (project: string): Error =>
  new Error(`unknown project "${project}"; cleared by: orch project list`)

const assertRegisteredProject = (project: string, database: Database = db()): void => {
  if (!projectRowByName(project, database)) throw unknownProject(project)
}

export function listSubjects(
  project: string,
  options: { retired?: boolean } = {},
  database: Database = db(),
): Subject[] {
  assertRegisteredProject(project, database)
  const rows = database
    .query<LocalRow, [string, number]>(
      `SELECT s.*,p.name AS project FROM subject s JOIN project p ON p.id=s.project_id
       WHERE p.name=? AND (? OR s.retired_at IS NULL) ORDER BY s.position,s.id`,
    )
    .all(project, options.retired ? 1 : 0)
  return rows.map(mapped)
}

export function resolveSubject(
  project: string,
  reference: string,
  database: Database = db(),
): Subject {
  assertRegisteredProject(project, database)
  const byId = database
    .query<LocalRow, [string, string]>(
      `SELECT s.*,p.name AS project FROM subject s JOIN project p ON p.id=s.project_id
       WHERE p.name=? AND s.id=?`,
    )
    .get(project, reference)
  if (byId) return mapped(byId)
  const matches = database
    .query<LocalRow, [string, string]>(
      `SELECT s.*,p.name AS project FROM subject s JOIN project p ON p.id=s.project_id
       WHERE p.name=? AND s.name=? AND s.retired_at IS NULL`,
    )
    .all(project, reference)
  if (matches.length === 1) return mapped(matches[0]!)
  if (matches.length > 1) {
    throw new Error(
      `subject name "${reference}" is ambiguous in project ${project}; use its UUID from: orch subject list ${project}`,
    )
  }
  throw new Error(
    `subject "${reference}" is not in project ${project}; cleared by: orch subject list ${project}`,
  )
}

function assertParent(database: Database, row: RecordSubject, projectId: number): void {
  if (row.parentId === null) return
  if (row.parentId === row.id) throw new Error('a subject cannot parent itself')
  const parent = database
    .query<{ project_id: number }, [string]>('SELECT project_id FROM subject WHERE id=?')
    .get(row.parentId)
  if (!parent || parent.project_id !== projectId) {
    throw new Error('a subject parent must belong to the same project')
  }
  let cursor: string | null = row.parentId
  const seen = new Set<string>()
  while (cursor !== null) {
    if (cursor === row.id) throw new Error('a subject parent would create a cycle')
    if (seen.has(cursor)) throw new Error('the stored subject parent chain contains a cycle')
    seen.add(cursor)
    cursor =
      database
        .query<{ parent_id: string | null }, [string]>('SELECT parent_id FROM subject WHERE id=?')
        .get(cursor)?.parent_id ?? null
  }
}

export function applySubjectRecord(row: RecordSubject, database: Database = db()): Subject {
  const project = projectRowByName(row.project, database)
  if (!project) {
    throw new Error(
      `cannot apply subject ${row.id}: project ${row.project} is not registered; cleared by: orch project add <path> --name ${row.project}`,
    )
  }
  const definition = SubjectDefinitionSchema.parse(row.definition)
  assertParent(database, row, project.id)
  try {
    database
      .query(
        `INSERT INTO subject
       (id,project_id,name,definition,position,parent_id,retired_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name,
         definition=excluded.definition,position=excluded.position,parent_id=excluded.parent_id,
         retired_at=excluded.retired_at,updated_at=excluded.updated_at`,
      )
      .run(
        row.id,
        project.id,
        row.name,
        definition,
        row.position,
        row.parentId,
        row.retiredAt,
        row.createdAt,
        row.updatedAt,
      )
  } catch (error) {
    if (String(error).includes('subject.project_id, subject.name')) {
      throw new Error(
        `subject "${row.name}" already exists in project ${row.project}; cleared by: orch subject list ${row.project}`,
      )
    }
    throw error
  }
  return { ...row, definition, state: subjectState(row.retiredAt) }
}

function localAdd(input: {
  id: string
  project: string
  name: string
  definition: string
}): Subject {
  const project = projectByName(input.project)
  if (!project) throw unknownProject(input.project)
  const at = nowIso()
  const position = db()
    .query<{ position: number }, [number]>(
      'SELECT COALESCE(MAX(position),-1)+1 AS position FROM subject WHERE project_id=? AND retired_at IS NULL',
    )
    .get(project.id)!.position
  return applySubjectRecord({
    ...input,
    position,
    parentId: null,
    retiredAt: null,
    state: 'active',
    createdAt: at,
    updatedAt: at,
  })
}

export async function addSubject(input: {
  project: string
  name: string
  definition: string
}): Promise<Subject> {
  assertRegisteredProject(input.project)
  writableDb()
  const definition = SubjectDefinitionSchema.parse(input.definition)
  if (!input.name.trim()) throw new Error('a subject name is required')
  const id = newRecordId()
  return applyRecordWriteAuthority({
    local: () => writeTransaction(() => localAdd({ ...input, definition, id })),
    hosted: async () => {
      const hosted = await subjectClient.add({ ...input, definition, id })
      return writeTransaction(() => applySubjectRecord(hosted))
    },
  })
}

async function mutate(
  project: string,
  id: string,
  local: (current: Subject, at: string) => RecordSubject,
  hosted: () => Promise<RecordSubject>,
): Promise<Subject> {
  assertRegisteredProject(project)
  writableDb()
  return applyRecordWriteAuthority({
    local: () =>
      writeTransaction(() => applySubjectRecord(local(resolveSubject(project, id), nowIso()))),
    hosted: async () => {
      const result = await hosted()
      return writeTransaction(() => applySubjectRecord(result))
    },
  })
}

export function renameSubject(project: string, id: string, name: string): Promise<Subject> {
  if (!name.trim()) throw new Error('a subject name is required')
  return mutate(
    project,
    id,
    (row, at) => ({ ...row, name, updatedAt: at }),
    () => subjectClient.rename(project, id, name),
  )
}

export function defineSubject(project: string, id: string, definition: string): Promise<Subject> {
  const parsedDefinition = SubjectDefinitionSchema.parse(definition)
  return mutate(
    project,
    id,
    (row, at) => ({ ...row, definition: parsedDefinition, updatedAt: at }),
    () => subjectClient.define(project, id, parsedDefinition),
  )
}

function localReorder(project: string, ids: string[], at = nowIso()): Subject[] {
  const active = listSubjects(project)
  const expected = active.map((row) => row.id).sort()
  const supplied = [...new Set(ids)].sort()
  if (ids.length !== supplied.length || JSON.stringify(expected) !== JSON.stringify(supplied)) {
    throw new Error(
      `reorder must name every non-retired subject in project ${project} exactly once; cleared by: orch subject list ${project}`,
    )
  }
  for (const [position, id] of ids.entries()) {
    db().query('UPDATE subject SET position=?,updated_at=? WHERE id=?').run(position, at, id)
  }
  return listSubjects(project)
}

export async function reorderSubjects(project: string, ids: string[]): Promise<Subject[]> {
  assertRegisteredProject(project)
  writableDb()
  return applyRecordWriteAuthority({
    local: () => writeTransaction(() => localReorder(project, ids)),
    hosted: async () => {
      const rows = await subjectClient.reorder(project, ids)
      return writeTransaction(() => {
        for (const row of rows) applySubjectRecord(row)
        return listSubjects(project)
      })
    },
  })
}

export function retireSubject(project: string, id: string): Promise<Subject> {
  return mutate(
    project,
    id,
    (row, at) => ({ ...row, retiredAt: row.retiredAt ?? at, updatedAt: at }),
    () => subjectClient.retire(project, id),
  )
}
