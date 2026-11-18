import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addProject } from '../../test/fixtures/offline-branch-landing.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
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
    const projectId = addProject('question-map-owner', process.cwd())
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

  test('the maintenance map refuses a number shared by projects but still resolves a UUID', async () => {
    const alphaProjectId = newRecordId()
    const betaProjectId = newRecordId()
    const alphaSpaceId = newRecordId()
    const betaSpaceId = newRecordId()
    const alphaQuestionId = newRecordId()
    const betaQuestionId = newRecordId()
    const previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    installRecordApiClient({
      whoami: async () => ({
        user: { id: newRecordId() },
        activeSpaceId: alphaSpaceId,
        personalSpaceId: null,
        memberships: [
          { space_id: alphaSpaceId, name: 'Alpha', slug: 'alpha', permission: 'write' },
          { space_id: betaSpaceId, name: 'Beta', slug: 'beta', permission: 'write' },
        ],
      }),
      readQuestions: async (
        input: { read: string },
        destination?: { destinationSpaceId: string },
      ) => ({
        items:
          input.read === 'by-id'
            ? [{ id: betaQuestionId, number: 71_002, project_record_id: betaProjectId }]
            : destination?.destinationSpaceId === betaSpaceId
              ? [{ id: betaQuestionId, number: 71_002, project_record_id: betaProjectId }]
              : [{ id: alphaQuestionId, number: 71_002, project_record_id: alphaProjectId }],
      }),
    } as unknown as RecordApiClient)
    try {
      await expect(questionIdentityMap(db(), [71_002])).rejects.toThrow(
        'question number 71002 exists in more than one project; pass the question UUID',
      )
      await expect(questionIdentityMap(db(), [betaQuestionId])).resolves.toEqual([
        { number: 71_002, record_id: betaQuestionId },
      ])
    } finally {
      installRecordApiClient(null)
      if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
      else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
    }
  })
})
