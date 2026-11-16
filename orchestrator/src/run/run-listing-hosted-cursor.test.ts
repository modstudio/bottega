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

function decodeRunCursor(line: string): { run: number; questions: string } {
  const envelope = OrchChangeCursorEnvelopeSchema.parse(JSON.parse(line))
  return JSON.parse(Buffer.from(envelope.data.cursor, 'base64url').toString()) as {
    run: number
    questions: string
  }
}

function decodeQuestionCursor(value: string): { version: number; spaces: Record<string, string> } {
  return JSON.parse(Buffer.from(value, 'base64url').toString()) as {
    version: number
    spaces: Record<string, string>
  }
}

async function probe(changedAfter = COLLECT_CHANGE_CURSOR_PROBE): Promise<string[]> {
  const lines: string[] = []
  await runListingCommand(
    { jsonV1: false, changedAfter },
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

  test('collection probe returns an advancing record question cursor without rows', async () => {
    const personalSpaceId = newRecordId()
    const changedAfter: Array<string | undefined> = []
    installRecordApiClient({
      whoami: async () => ({
        user: { id: newRecordId() },
        activeSpaceId: newRecordId(),
        personalSpaceId,
        memberships: [],
      }),
      readQuestions: async (
        input: Parameters<NonNullable<RecordApiClient['readQuestions']>>[0],
      ) => {
        changedAfter.push(input.changedAfter)
        return { items: [], cursor: `record-position-${changedAfter.length}` }
      },
    } as unknown as RecordApiClient)

    const initialLines = await probe()
    expect(initialLines.slice(0, -1).map(runJson)).toEqual([])
    const initial = decodeRunCursor(initialLines.at(-1)!)
    expect(initial).toEqual({ run: 0, questions: '0' })
    expect(changedAfter).toEqual([])

    const followUpLines = await probe(
      OrchChangeCursorEnvelopeSchema.parse(JSON.parse(initialLines.at(-1)!)).data.cursor,
    )
    expect(followUpLines.slice(0, -1).map(runJson)).toEqual([])
    const followUpEnvelope = OrchChangeCursorEnvelopeSchema.parse(JSON.parse(followUpLines.at(-1)!))
    const followUp = decodeRunCursor(followUpLines.at(-1)!)
    expect(followUp.run).toBe(0)
    expect(decodeQuestionCursor(followUp.questions)).toEqual({
      version: 1,
      spaces: { [personalSpaceId]: 'record-position-1' },
    })
    expect(changedAfter).toEqual([undefined])

    const thirdLines = await probe(followUpEnvelope.data.cursor)
    expect(thirdLines.slice(0, -1).map(runJson)).toEqual([])
    expect(changedAfter).toEqual([undefined, 'record-position-1'])
    expect(decodeQuestionCursor(decodeRunCursor(thirdLines.at(-1)!).questions)).toEqual({
      version: 1,
      spaces: { [personalSpaceId]: 'record-position-2' },
    })
  })
})

describe('run listing local change cursor', () => {
  let previousRecordApiUrl: string | undefined

  beforeEach(() => {
    previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
    delete process.env.BOTTEGA_RECORD_API_URL
  })

  afterEach(() => {
    if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
  })

  test('collection probe returns the current local question position without rows', async () => {
    const lines = await probe()
    expect(lines.slice(0, -1).map(runJson)).toEqual([])
    expect(decodeRunCursor(lines.at(-1)!)).toEqual({ run: 0, questions: '0' })
  })
})
