import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { job, OUTPUT_RESERVE, PROMPT_BYTES_PER_TOKEN } from '../jobs/jobs.ts'
import { type AgentRow, addAgent, gooseContextLimit, rowAgent } from './agent-registry.ts'
import { type Agent, assertResumableAgent } from './agents.ts'

function codexRow(probeResult: unknown): AgentRow {
  const row = db().query("SELECT * FROM agent WHERE name = 'codex'").get() as AgentRow
  return { ...row, probe_result: JSON.stringify(probeResult) }
}

function gooseRow(contextTokens?: number): AgentRow {
  const row = codexRow({ ok: true })
  const { contextTokens: _contextTokens, ...caps } = JSON.parse(row.caps)
  return {
    ...row,
    harness: 'goose',
    model: 'fixture-model',
    base_url: 'http://fixture.invalid/v1',
    caps: JSON.stringify({
      ...caps,
      ...(contextTokens === undefined ? {} : { contextTokens }),
    }),
  }
}

const DEEP_JOB_TOKENS = job('implement').contextTokens
const DEEP_JOB_BUDGET = DEEP_JOB_TOKENS + OUTPUT_RESERVE
/** A prompt whose estimate is 5K tokens bigger than the job's whole budget. */
const BIG_PROMPT_TOKENS = DEEP_JOB_BUDGET + 5_000
const BIG_PROMPT_BYTES = BIG_PROMPT_TOKENS * PROMPT_BYTES_PER_TOKEN

test('a deep job on a wide served window runs to the job budget, not the window', () => {
  expect(gooseContextLimit(1_048_576, DEEP_JOB_TOKENS, null)).toBe(DEEP_JOB_BUDGET)
})

test('a served window smaller than the job budget caps the limit', () => {
  expect(gooseContextLimit(65_536, DEEP_JOB_TOKENS, null)).toBe(65_536)
})

test('no served window leaves the job budget', () => {
  expect(gooseContextLimit(null, DEEP_JOB_TOKENS, null)).toBe(DEEP_JOB_BUDGET)
})

test('a prompt larger than the job budget raises the limit by its estimate, capped by the window', () => {
  expect(gooseContextLimit(1_048_576, DEEP_JOB_TOKENS, BIG_PROMPT_BYTES)).toBe(
    DEEP_JOB_BUDGET + BIG_PROMPT_TOKENS,
  )
  const narrow = DEEP_JOB_BUDGET + 1_000
  expect(gooseContextLimit(narrow, DEEP_JOB_TOKENS, BIG_PROMPT_BYTES)).toBe(narrow)
})

test('a goose row without a declared context window keeps the goose default', () => {
  expect(rowAgent(gooseRow()).env?.()).not.toHaveProperty('GOOSE_CONTEXT_LIMIT')
})

test('a probe result with no ok verdict is unknown', () => {
  expect(rowAgent(codexRow({ source: 'legacy' })).probePassed).toBeNull()
})

test('an explicit null probe verdict is unknown', () => {
  expect(rowAgent(codexRow({ ok: null })).probePassed).toBeNull()
})

test('an explicit false probe verdict is not passed', () => {
  expect(rowAgent(codexRow({ ok: false })).probePassed).toBe(false)
})

test('an explicit true probe verdict is passed', () => {
  expect(rowAgent(codexRow({ ok: true })).probePassed).toBe(true)
})

test('a registered agent is created with a version-seven record id', () => {
  addAgent('identity-fixture', {
    harness: 'codex',
    backend: 'vendor',
    model: 'fixture',
  })
  const row = db().query("SELECT record_id FROM agent WHERE name='identity-fixture'").get() as {
    record_id: string
  }
  expect(row.record_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
})

test('a resumable ACP registry row loads with its session/load adapter facility', () => {
  const row = codexRow({ ok: true })
  const caps = { ...JSON.parse(row.caps), resumable: true }
  const loaded = rowAgent({ ...row, caps: JSON.stringify(caps), transport: 'acp' })
  expect(loaded.acpSessionLoad).toBe(true)
  expect(() => assertResumableAgent(row.name, loaded, false)).not.toThrow()
})

test('a CLI row cannot claim resumable without resume argv and a session id source', () => {
  const row = codexRow({ ok: true })
  const caps = { ...JSON.parse(row.caps), resumable: true }
  const loaded = rowAgent({ ...row, caps: JSON.stringify(caps), transport: 'cli' })
  const invalid = {
    ...loaded,
    resumeArgv: undefined,
    mintSession: undefined,
    readSession: undefined,
  }
  expect(() => assertResumableAgent(row.name, invalid as Agent, false)).toThrow('no resumeArgv')
})
