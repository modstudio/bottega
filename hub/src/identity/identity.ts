// concern: hub-identity
/** Resolves hub-owned numbered identities and guards their natural-key uniqueness. */

import type { Database } from 'bun:sqlite'
import { parseReference, REFERENCE_PREFIXES } from '../../../shared/reference.ts'
import {
  malformedReferenceRefusal,
  NOTE_REFERENCE_FORMS,
  projectNotRegisteredRefusal,
  referenceNotVisibleRefusal,
  uuidQualifierRefusal,
} from '../../../shared/reference-refusal.ts'

export function resolveNoteIdentity(
  database: Database,
  value: string,
  sessionProject: string | null,
  isRegistered: (project: string) => boolean,
): string {
  let parsed: ReturnType<typeof parseReference>
  try {
    parsed = parseReference(value, 'note')
  } catch {
    throw new Error(malformedReferenceRefusal(value, NOTE_REFERENCE_FORMS))
  }
  if (parsed.qualifier?.kind === 'machine')
    throw new Error(malformedReferenceRefusal(value, NOTE_REFERENCE_FORMS))
  if (parsed.qualifier && !isRegistered(parsed.qualifier.value))
    throw new Error(projectNotRegisteredRefusal(parsed.qualifier.value))
  if (parsed.value.kind === 'record-id') {
    if (parsed.qualifier) throw new Error(uuidQualifierRefusal())
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
    throw new Error(malformedReferenceRefusal(value, NOTE_REFERENCE_FORMS))
  const recordId = project ? noteIdentityByNumber(database, project, number) : null
  if (recordId) return recordId
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
