import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { unjudgedRuns } from './unjudged-expiry.ts'

test('unjudged expiry selects a judgeable failed run whose owner is gone', () => {
  const failed = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'contract',
    session: null,
  })
  addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'auth',
    session: null,
  })

  expect(unjudgedRuns(null).map((row) => row.record_id)).toEqual([failed])
})
