import { expect, test } from 'bun:test'
import { setMachineValue } from '../../../shared/machine-config.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { candidates, pick } from './route.ts'

test('the shared routing path launches a first harness turn and still refuses failover', () => {
  setMachineValue('delegation.implement', 'harness')
  try {
    expect(
      pick('implement', undefined, 0, true, null, {}, false, undefined, Math.random, {
        allowHarness: true,
      }),
    ).toEqual({
      agent: 'harness',
      reason: 'machine delegation mode',
    })
    expect(() =>
      pick('implement', 'not-an-agent', 0, true, null, {}, false, undefined, Math.random, {
        allowHarness: false,
      }),
    ).toThrow(
      "this machine runs implement work through the harness's own sub-agent (delegation.implement=harness)",
    )
  } finally {
    setMachineValue('delegation.implement', 'external')
  }
})

test('the shared routing path launches a review job assigned to the harness', () => {
  setMachineValue('delegation.review', 'harness')
  try {
    expect(pick('review-lens')).toEqual({ agent: 'harness', reason: 'machine delegation mode' })
  } finally {
    setMachineValue('delegation.review', 'external')
  }
})

test('a scored harness run does not change external routing evidence', () => {
  const external = addRun({ agent: 'codex', job: 'craft', status: 'ok' })
  score(external, 'full', 'right', 'faithful')
  const before = candidates('craft')

  const harness = addRun({ agent: 'harness', job: 'craft', status: 'ok' })
  db().query("UPDATE run SET executor='harness' WHERE record_id=?").run(harness)
  score(harness, 'none')

  expect(candidates('craft')).toEqual(before)
})
