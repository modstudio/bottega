import { expect, test } from 'bun:test'
import { runJson } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { runListingCommand } from './run-listing.ts'

async function offsetWindowRows(since: string) {
  const lines: string[] = []
  await runListingCommand(
    { jsonV1: false, changedAfter: null },
    {
      has: (name) => name === 'json' || name === 'since',
      flag: (name) => (name === 'since' ? since : undefined),
      values: (name) => (name === 'since' ? [since] : []),
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
  return lines.map(runJson)
}

test('run list --since normalizes a time-zone offset before selecting exact rows', async () => {
  addRun({ agent: 'codex', job: 'understand', startedAt: '2026-11-19T05:30:00.000Z' })
  const after = addRun({
    agent: 'codex',
    job: 'understand',
    startedAt: '2026-11-19T06:30:00.000Z',
  })

  expect((await offsetWindowRows('2026-11-19T01:00:00-05:00')).map((row) => row.record_id)).toEqual(
    [after],
  )
})
