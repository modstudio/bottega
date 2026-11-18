import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CALLER_TOKEN_MAX_LENGTH, callerToken } from '../../../shared/record-caller.ts'
import { refusal } from '../../../shared/refusal.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { RefusalError } from '../refusal-error.ts'
import { executorCallerToken, main, startupFailureDiagnostic } from './exec.ts'

test('the detached executor tags inherited, absent, and over-long callers', () => {
  expect(executorCallerToken('cli:run/start')).toBe('exec:run.cli:run/start')
  expect(executorCallerToken(undefined)).toBe('exec:run')
  expect(executorCallerToken('exec:parent.cli:run/start')).toBe(
    'exec:run.exec:parent.cli:run/start',
  )
  const overLong = executorCallerToken(`cli:${'x'.repeat(CALLER_TOKEN_MAX_LENGTH)}`)
  expect(overLong).toHaveLength(CALLER_TOKEN_MAX_LENGTH)
  expect(overLong.startsWith('exec:run.')).toBe(true)
  expect(callerToken(undefined, overLong)).toBe(overLong)
})

test('a startup refusal reports its message without a stack', () => {
  const error = new RefusalError(refusal(`run ${PLATFORM_SLUG} agent probe codex`))
  expect(startupFailureDiagnostic(error)).toBe(`run ${PLATFORM_SLUG} agent probe codex`)
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
