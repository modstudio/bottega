import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OrchChangeCursorEnvelopeSchema } from '../../../shared/orch-contract.ts'
import { runJson } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { runListingCommand } from './run-listing.ts'

function decodedCursor(line: string): { run: number; questions: string } {
  const envelope = OrchChangeCursorEnvelopeSchema.parse(JSON.parse(line))
  return JSON.parse(Buffer.from(envelope.data.cursor, 'base64url').toString()) as {
    run: number
    questions: string
  }
}

async function changedRuns(changedAfter: string, job: string): Promise<string[]> {
  const lines: string[] = []
  await runListingCommand(
    { jsonV1: false, changedAfter },
    {
      has: (name) => name === 'json' || name === 'job',
      flag: (name) => (name === 'job' ? job : undefined),
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

  test('legacy cursor snapshots the counter and its envelope returns only later changes', async () => {
    const job = `local-cursor-${crypto.randomUUID()}`
    const unchanged = addRun({ agent: 'codex', job })
    const changed = addRun({ agent: 'codex', job })
    const first = await changedRuns('3', job)
    const snapshot =
      db().query<{ value: number }, []>('SELECT value FROM collect_change_counter').get()?.value ??
      0
    const firstCursor = OrchChangeCursorEnvelopeSchema.parse(JSON.parse(first.at(-1)!)).data.cursor

    expect(decodedCursor(first.at(-1)!)).toEqual({ run: snapshot, questions: '0' })

    db().query("UPDATE run SET status='running' WHERE record_id=?").run(changed)
    const second = await changedRuns(firstCursor, job)
    const rows = second.slice(0, -1).map(runJson)

    expect(rows.map((row) => row.record_id)).toEqual([changed])
    expect(rows.map((row) => row.record_id)).not.toContain(unchanged)
    expect(decodedCursor(second.at(-1)!).run).toBeGreaterThan(snapshot)
  })

  test('malformed cursor refuses with the changed-after remedy', async () => {
    await expect(changedRuns('not-a-cursor', 'irrelevant')).rejects.toThrow(
      '--changed-after cursor is malformed',
    )
  })
})
