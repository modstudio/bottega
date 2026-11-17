import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  parseQuestionIdentifier,
  questionIdentityMap,
  resolveQuestionIdentifier,
} from './question-identifier.ts'

describe('question identifier', () => {
  test('parses numbers and UUIDs and resolves either form to one row', async () => {
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
    expect(await resolveQuestionIdentifier(db(), number)).toBe(recordId)
    expect(await resolveQuestionIdentifier(db(), recordId)).toBe(recordId)
  })

  test('the maintenance map resolves a number in its owning project', async () => {
    const projectId = addProject('question-map-owner', '/work/question-map-owner')
    const runId = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      projectRecordId: projectId,
    })
    const recordId = newRecordId()
    db()
      .query(
        "INSERT INTO question (record_id,number,run_record_id,asked_at,question) VALUES (?,71001,?,'2026-10-14','Which?')",
      )
      .run(recordId, runId)

    await expect(questionIdentityMap(db(), [71001])).resolves.toEqual([
      { number: 71001, record_id: recordId },
    ])
  })
})
