import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  COLLECT_CHANGE_CURSOR_PROBE,
  OrchChangeCursorEnvelopeSchema,
} from '../../../shared/orch-contract.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { runJson } from '../../test/fixtures/replies.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { runListingCommand } from './run-listing.ts'

let previousRecordApiUrl: string | undefined

beforeEach(() => {
  previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
})

afterEach(() => {
  installRecordApiClient(null)
  if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
})

function decodeRunCursor(line: string): { run: number; questions: string } {
  const envelope = OrchChangeCursorEnvelopeSchema.parse(JSON.parse(line))
  return JSON.parse(Buffer.from(envelope.data.cursor, 'base64url').toString()) as {
    run: number
    questions: string
  }
}

async function probe(): Promise<string[]> {
  const lines: string[] = []
  await runListingCommand(
    { jsonV1: false, changedAfter: COLLECT_CHANGE_CURSOR_PROBE },
    {
      has: (name) => name === 'json',
      flag: () => undefined,
      values: () => [],
    },
    {
      log: (...parts) => lines.push(parts.join(' ')),
      dur: (ms) => String(ms ?? 0),
      chainIsStranded: () => false,
      strandedRecovery: () => '',
      thinOutputWarning: () => null,
      processObservation: { sampleProcesses: () => [], processStartTime: () => null },
      clock: Date.now,
    },
  )
  return lines
}

describe('run listing hosted change cursor', () => {
  test('collection probe returns an advancing record question cursor without rows', async () => {
    installRecordApiClient({
      whoami: async () => ({
        user: { id: newRecordId() },
        activeSpaceId: newRecordId(),
        personalSpaceId: newRecordId(),
        memberships: [],
      }),
      readQuestions: async () => ({ items: [], cursor: 'record-position' }),
    } as RecordApiClient)
    const lines = await probe()
    expect(lines.slice(0, -1).map(runJson)).toEqual([])
    expect(decodeRunCursor(lines.at(-1)!)).toEqual({ run: 0, questions: '0' })
  })

  test('local collection probe returns an advancing question cursor without rows', async () => {
    delete process.env.BOTTEGA_RECORD_API_URL
    const lines = await probe()
    expect(lines.slice(0, -1).map(runJson)).toEqual([])
    expect(decodeRunCursor(lines.at(-1)!)).toEqual({ run: 0, questions: '0' })
  })
})
