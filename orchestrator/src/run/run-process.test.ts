import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { acceptableRunProcessIds, commandNamesRun } from './run-process.ts'

test('a coordinator command may name any run in the acceptable chain', () => {
  expect(commandNamesRun('bun orchestrator/src/exec.ts 41', [41, 42])).toBe(true)
  expect(commandNamesRun('bun orchestrator/src/exec.ts 41', [42, 41])).toBe(true)
  expect(commandNamesRun('bun orchestrator/src/exec.ts 43', [41, 42])).toBe(false)
  expect(commandNamesRun('bun orchestrator/src/exec.ts 410', [41])).toBe(false)
})

test('process identity follows automatic failover conversations but not manual retries', () => {
  const original = addRun({ agent: 'codex', job: 'implement' })
  const originalTurn = addRun({ agent: 'codex', job: 'implement', parent: original, turn: 2 })
  const failover = addRun({ agent: 'claude', job: 'implement' })
  const failoverTurn = addRun({ agent: 'claude', job: 'implement', parent: failover, turn: 2 })
  db()
    .query('UPDATE run SET retry_of=?, automatic_failover=1 WHERE id=?')
    .run(originalTurn, failover)
  const manualRetry = addRun({ agent: 'grok', job: 'implement' })
  db().query('UPDATE run SET retry_of=? WHERE id=?').run(failoverTurn, manualRetry)

  const acceptable = acceptableRunProcessIds(failoverTurn)
  expect(acceptable).toEqual([original, originalTurn, failover, failoverTurn])
  expect(commandNamesRun(`bun orchestrator/src/exec.ts ${original}`, acceptable)).toBe(true)
  const manualAcceptable = acceptableRunProcessIds(manualRetry)
  expect(commandNamesRun(`bun orchestrator/src/exec.ts ${original}`, manualAcceptable)).toBe(false)
})
