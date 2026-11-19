import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { recordRunQuestionReadiness } from './run-question-readiness.ts'

const MACHINE_ID = '01990000-0000-7000-8000-000000000099'

function row(runId: string): { status: string; vendor_session: string | null } {
  return db()
    .query<{ status: string; vendor_session: string | null }, [string]>(
      'SELECT status,vendor_session FROM run WHERE record_id=?',
    )
    .get(runId)!
}

test('a questionless reply persists its session without changing running status', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })

  recordRunQuestionReadiness(
    { machineId: MACHINE_ID, resolvedSession: 'session-before-terminal-row' },
    runId,
    [],
  )

  expect(row(runId)).toEqual({
    status: 'running',
    vendor_session: 'session-before-terminal-row',
  })
})
