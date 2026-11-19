// concern: hub-identity
/** Resolves hub-owned numbered identities and guards their natural-key uniqueness. */

import type { Database } from 'bun:sqlite'
import type { SQL } from 'bun'
import { parseReference, REFERENCE_PREFIXES } from '../../../shared/reference.ts'
import { referenceNotVisibleRefusal } from '../../../shared/reference-refusal.ts'

export function resolveNoteIdentity(
  database: Database,
  value: string,
  sessionProject: string | null,
): string {
  const parsed = parseReference(value, 'note')
  if (parsed.qualifier?.kind === 'machine')
    throw new Error('note references accept a project qualifier, not a machine qualifier')
  if (parsed.value.kind === 'record-id') {
    const row = database
      .query<{ record_id: string }, [string]>('SELECT record_id FROM note WHERE record_id=?')
      .get(parsed.value.recordId)
    if (row) return row.record_id
    throw new Error(
      referenceNotVisibleRefusal('any project you can see', 'pass a visible UUID or note label'),
    )
  }
  const number = 'number' in parsed.value ? parsed.value.number : null
  const validLabel =
    parsed.value.kind !== 'label' || parsed.value.prefix === REFERENCE_PREFIXES.note
  const project = parsed.qualifier?.value ?? sessionProject
  if (number === null || !validLabel)
    throw new Error('a note reference must be n<number>, a number, <project>#<number>, or a UUID')
  const row = project
    ? database
        .query<{ record_id: string }, [string, number]>(
          'SELECT record_id FROM note WHERE project=? AND number=?',
        )
        .get(project, number)
    : null
  if (row) return row.record_id
  throw new Error(
    referenceNotVisibleRefusal(
      project ? `project ${project}` : "the caller's project",
      'pass the UUID or a <project>#<number> label',
    ),
  )
}

export function taskDocumentIdentityByNumber(
  database: Database,
  taskRecordId: string,
  number: number,
): string | null {
  return (
    database
      .query<{ record_id: string }, [string, number]>(
        'SELECT record_id FROM task_document WHERE task_record_id=? AND number=?',
      )
      .get(taskRecordId, number)?.record_id ?? null
  )
}

export function noteIdentityByNumber(
  database: Database,
  project: string,
  number: number,
): string | null {
  return (
    database
      .query<{ record_id: string }, [string, number]>(
        'SELECT record_id FROM note WHERE project=? AND number=?',
      )
      .get(project, number)?.record_id ?? null
  )
}

export function otherTaskDocumentIdentityByNumber(
  database: Database,
  taskRecordId: string,
  number: number,
  recordId: string,
): string | null {
  return (
    database
      .query<{ record_id: string }, [string, number, string]>(
        'SELECT record_id FROM task_document WHERE task_record_id=? AND number=? AND record_id<>?',
      )
      .get(taskRecordId, number, recordId)?.record_id ?? null
  )
}

export async function hostedNoteIdentityByNumber(
  tx: SQL,
  spaceId: string,
  projectId: string,
  number: number,
): Promise<{ id: string; space_id: string } | null> {
  const rows = (await tx`SELECT id, space_id FROM hub_note
    WHERE space_id=${spaceId}::uuid AND project_id=${projectId}::uuid
    AND number=${number} FOR UPDATE`) as Array<{ id: string; space_id: string }>
  return rows[0] ?? null
}

export async function otherHostedTaskDocumentIdentityByNumber(
  tx: SQL,
  spaceId: string,
  taskId: string,
  number: number,
  recordId: string,
): Promise<string | null> {
  const rows = (await tx`SELECT id FROM hub_task_document
    WHERE space_id=${spaceId}::uuid AND task_id=${taskId}::uuid
    AND number=${number} AND id<>${recordId}::uuid`) as Array<{ id: string }>
  return rows[0]?.id ?? null
}
