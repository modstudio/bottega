import { expect, test } from 'bun:test'
import { db, writableDb } from '../database/db.ts'
import {
  recordAgentProbe,
  registrationProbeCacheReusable,
  registrationProbeRequirements,
} from './agent-probe.ts'
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
    resumable: false,
    file: true,
  })
})

function result(
  writing: boolean | null,
  resuming: boolean | null = writing,
): RegistrationProbeResult {
  return {
    harness: 'goose',
    ok: true,
    reply: { ok: true, output: 'ok' },
    tool: { ok: true, output: 'ok', toolEvents: 1, statuses: ['completed'] },
    schema: { ok: true, output: 'ok' },
    file: { ok: true, output: '{"status":"ok"}' },
    mcp: { verifiable: true, output: 'ok' },
    writing: { ok: writing, output: writing ? 'created' : 'not created' },
    resuming: { ok: resuming, output: resuming ? 'recalled token' : 'did not recall token' },
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
  expect(JSON.parse(registeredCaps('writing-capability-fixture'))).toMatchObject({
    readsRepo: true,
    schema: true,
    writesRepo: false,
  })
})

test('an observed ACP resume result sets or clears resumable', () => {
  registered('resume-capability-fixture')
  recordAgentProbe('resume-capability-fixture', result(true, true))
  expect(JSON.parse(registeredCaps('resume-capability-fixture')).resumable).toBe(true)

  recordAgentProbe('resume-capability-fixture', result(true, false))
  expect(JSON.parse(registeredCaps('resume-capability-fixture')).resumable).toBe(false)
})

test('a CLI probe with no writing observation preserves an existing writing capability', () => {
  addAgent('cli-writing-capability-fixture', {
    harness: 'codex',
    backend: 'vendor',
    model: 'fixture',
  })
  const caps = JSON.parse(registeredCaps('cli-writing-capability-fixture'))
  writableDb()
    .query('UPDATE agent SET caps=? WHERE name=?')
    .run(JSON.stringify({ ...caps, writesRepo: true }), 'cli-writing-capability-fixture')
  writableDb()
    .query('UPDATE agent SET caps=? WHERE name=?')
    .run(
      JSON.stringify({ ...caps, writesRepo: true, resumable: true }),
      'cli-writing-capability-fixture',
    )
  recordAgentProbe('cli-writing-capability-fixture', result(null, null))
  expect(JSON.parse(registeredCaps('cli-writing-capability-fixture'))).toMatchObject({
    writesRepo: true,
    resumable: true,
  })
})

test('cache reuse requires observed ACP capabilities only when the declared jobs need them', () => {
  const previous = result(null)
  expect(registrationProbeCacheReusable('acp', previous, true, true)).toBe(false)
  expect(registrationProbeCacheReusable('cli', previous, true, true)).toBe(true)
  const failedResume = result(true, false)
  expect(registrationProbeCacheReusable('acp', failedResume, true, false)).toBe(true)
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
