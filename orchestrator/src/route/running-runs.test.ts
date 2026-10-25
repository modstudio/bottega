import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { addAgent, refreshAgents } from '../agent/agent-registry.ts'
import { runningRunCountForHarness, runningRunCountsForAgents } from './running-runs.ts'

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

test('harness count includes aliased live runs and excludes other run states and harnesses', () => {
  addAgent('codex-alias', { harness: 'codex', backend: 'vendor', model: 'fixture' })
  refreshAgents()
  addRun({ agent: 'codex', job: 'craft', status: 'running' })
  addRun({ agent: 'codex-alias', job: 'craft', status: 'running' })
  addRun({ agent: 'codex-alias', job: 'craft', status: 'running', probe: 1 })
  addRun({ agent: 'codex-alias', job: 'craft', status: 'ok' })
  addRun({ agent: 'claude', job: 'craft', status: 'running' })

  expect(runningRunCountForHarness('codex')).toBe(2)
})
