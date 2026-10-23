import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { runningRunCountsForAgents } from './running-runs.ts'

test('running counts include only live non-probe runs for the requested agents', () => {
  addRun({ agent: 'codex', job: 'craft', status: 'running' })
  addRun({ agent: 'codex', job: 'craft', status: 'running' })
  addRun({ agent: 'codex', job: 'craft', status: 'running', probe: 1 })
  addRun({ agent: 'codex', job: 'craft', status: 'ok' })
  addRun({ agent: 'claude', job: 'craft', status: 'running' })

  expect(runningRunCountsForAgents(['codex', 'grok', 'codex'])).toEqual({
    codex: 2,
    grok: 0,
  })
})
