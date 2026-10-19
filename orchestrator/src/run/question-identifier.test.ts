import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { parseQuestionIdentifier, resolveQuestionIdentifier } from './question-identifier.ts'

describe('question identifier', () => {
  test('parses numbers and UUIDs and resolves either form to one row', () => {
    const runId = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const recordId = newRecordId()
    const { id } = db()
      .query<{ id: number }, [string, string]>(
        "INSERT INTO question (record_id,run_record_id,asked_at,question) VALUES (?,?,'2026-10-14','Which?') RETURNING id",
      )
      .get(recordId, runId)!
    expect(parseQuestionIdentifier(String(id))).toEqual({ kind: 'number', id })
    expect(parseQuestionIdentifier(recordId.toUpperCase())).toEqual({
      kind: 'record-id',
      recordId,
    })
    expect(resolveQuestionIdentifier(db(), id)).toBe(id)
    expect(resolveQuestionIdentifier(db(), recordId)).toBe(id)
  })
})
