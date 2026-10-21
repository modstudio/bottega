import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { RefusalError } from '../refusal-error.ts'
import { main, startupFailureDiagnostic } from './exec.ts'

test('a startup refusal reports its message without a stack', () => {
  const refusal = new RefusalError(`run ${PLATFORM_SLUG} agent show probe codex`)
  expect(startupFailureDiagnostic(refusal)).toBe(`run ${PLATFORM_SLUG} agent show probe codex`)
})

test('an unexpected startup error keeps its stack', () => {
  const error = new Error('unexpected startup failure')
  expect(startupFailureDiagnostic(error)).toBe(error.stack!)
})

test('the detached entry point durably fails and publishes a reservation after startup breaks', async () => {
  const id = addRun({ agent: '(pending)', job: 'summarize', status: 'running' })

  expect(await main([id, '/missing-detached-prompt', 'summarize'])).toBe(1)

  expect(
    db().query('SELECT status, failure_kind, latency_ms FROM run WHERE record_id=?').get(id),
  ).toEqual({ status: 'failed', failure_kind: 'harness', latency_ms: 0 })
  expect(db().query("SELECT kind FROM outbox WHERE row_id=? AND kind='run'").get(id)).toEqual({
    kind: 'run',
  })
})
