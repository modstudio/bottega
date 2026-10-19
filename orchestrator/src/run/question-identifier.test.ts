import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { parseQuestionIdentifier, resolveQuestionIdentifier } from './question-identifier.ts'

describe('question identifier', () => {
  test('parses numbers and UUIDs and resolves either form to one row', () => {
    const runId = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const recordId = newRecordId()
    const { number } = db()
      .query<{ number: number }, [string, string]>(
        "INSERT INTO question (record_id,number,run_record_id,asked_at,question) VALUES (?,1,?,'2026-10-14','Which?') RETURNING number",
      )
      .get(recordId, runId)!
    expect(parseQuestionIdentifier(String(number))).toEqual({ kind: 'number', id: number })
    expect(parseQuestionIdentifier(recordId.toUpperCase())).toEqual({
      kind: 'record-id',
      recordId,
    })
    expect(resolveQuestionIdentifier(db(), number)).toBe(recordId)
    expect(resolveQuestionIdentifier(db(), recordId)).toBe(recordId)
  })
})
