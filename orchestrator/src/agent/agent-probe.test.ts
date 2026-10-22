import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { recordAgentProbe, registrationProbeRequirements } from './agent-probe.ts'
import {
  type AgentRow,
  addAgent,
  agentRows,
  type RegistrationProbeResult,
  setAgent,
} from './agent-registry.ts'

test('a file-question registration probe always requires the reply file but not native schema', () => {
  expect(registrationProbeRequirements(['file-question'])).toEqual({
    tool: true,
    schema: false,
    mcp: false,
    file: true,
  })
})

function result(writing: boolean | null): RegistrationProbeResult {
  return {
    harness: 'goose',
    ok: true,
    reply: { ok: true, output: 'ok' },
    tool: { ok: true, output: 'ok', toolEvents: 1, statuses: ['completed'] },
    schema: { ok: true, output: 'ok' },
    file: { ok: true, output: '{"status":"ok"}' },
    mcp: { verifiable: true, output: 'ok' },
    writing: { ok: writing, output: writing ? 'created' : 'not created' },
    contextTokens: null,
    contextSource: null,
  }
}

function registered(name: string): AgentRow {
  addAgent(name, { harness: 'goose', backend: 'vendor', model: 'fixture' })
  return agentRows().find((row) => row.name === name)!
}

test('a passing writing observation sets writesRepo and a failing one leaves it false', () => {
  registered('writing-capability-fixture')
  recordAgentProbe('writing-capability-fixture', result(true))
  expect(JSON.parse(registeredCaps('writing-capability-fixture')).writesRepo).toBe(true)

  recordAgentProbe('writing-capability-fixture', result(false))
  expect(JSON.parse(registeredCaps('writing-capability-fixture')).writesRepo).toBe(false)
})

test('changing an agent identity resets a probed writing capability', () => {
  registered('writing-identity-fixture')
  recordAgentProbe('writing-identity-fixture', result(true))
  setAgent('writing-identity-fixture', { model: 'changed-fixture' })
  expect(JSON.parse(registeredCaps('writing-identity-fixture')).writesRepo).toBe(false)
})

function registeredCaps(name: string): string {
  return (db().query('SELECT caps FROM agent WHERE name=?').get(name) as { caps: string }).caps
}
