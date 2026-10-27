import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { job, jobContextBudget, OUTPUT_RESERVE, PROMPT_BYTES_PER_TOKEN } from '../jobs/jobs.ts'
import {
  type AgentRow,
  addAgent,
  GOOSE_CONTEXT_CEILING,
  GOOSE_READING_MAX_TURNS,
  gooseContextLimit,
  rowAgent,
} from './agent-registry.ts'
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

const DEEP_JOB_TOKENS = job('review-lens').contextTokens
const DEEP_JOB_BUDGET = DEEP_JOB_TOKENS + OUTPUT_RESERVE
/** A prompt whose estimate is 5K tokens bigger than the job's whole budget. */
const BIG_PROMPT_TOKENS = DEEP_JOB_BUDGET + 5_000
const BIG_PROMPT_BYTES = BIG_PROMPT_TOKENS * PROMPT_BYTES_PER_TOKEN

test('the Goose context ceiling preserves its measured pre-regression value', () => {
  expect(GOOSE_CONTEXT_CEILING).toBe(128_000)
})

test('a review lens on a wide served window runs at the Goose context ceiling', () => {
  expect(gooseContextLimit(200_000, DEEP_JOB_TOKENS, null)).toBe(GOOSE_CONTEXT_CEILING)
})

test('a job budget below the Goose context ceiling remains the working limit', () => {
  const errandTokens = job('file-question').contextTokens
  expect(gooseContextLimit(200_000, errandTokens, null)).toBe(jobContextBudget(errandTokens))
})

test('a served window smaller than the Goose context ceiling caps the limit', () => {
  expect(gooseContextLimit(65_536, DEEP_JOB_TOKENS, null)).toBe(65_536)
})

test('no served window leaves the Goose working limit', () => {
  expect(gooseContextLimit(null, DEEP_JOB_TOKENS, null)).toBe(GOOSE_CONTEXT_CEILING)
})

test('a prompt larger than the ceiling raises the limit by its estimate, capped by the window', () => {
  expect(gooseContextLimit(1_048_576, DEEP_JOB_TOKENS, BIG_PROMPT_BYTES)).toBe(
    BIG_PROMPT_TOKENS + OUTPUT_RESERVE,
  )
  const narrow = BIG_PROMPT_TOKENS + 1_000
  expect(gooseContextLimit(narrow, DEEP_JOB_TOKENS, BIG_PROMPT_BYTES)).toBe(narrow)
})

test('no job leaves the Goose context limit unset', () => {
  expect(gooseContextLimit(200_000, null, BIG_PROMPT_BYTES)).toBeNull()
})

test('a goose row without a declared context window keeps the goose default', () => {
  const env = rowAgent(gooseRow()).env?.()
  expect(env).not.toHaveProperty('GOOSE_CONTEXT_LIMIT')
  expect(env).not.toHaveProperty('GOOSE_MAX_TURNS')
})

test('a Goose reading job sets the turn ceiling; a writing job and a non-Goose row do not', () => {
  const goose = rowAgent(gooseRow(200_000))
  const reading = Boolean(job('review-lens').needs.writesRepo)
  const writing = Boolean(job('implement').needs.writesRepo)
  expect(goose.env?.(job('review-lens').contextTokens, null, reading)).toMatchObject({
    GOOSE_MAX_TURNS: String(GOOSE_READING_MAX_TURNS),
  })
  expect(goose.env?.(job('implement').contextTokens, null, writing)).not.toHaveProperty(
    'GOOSE_MAX_TURNS',
  )
  expect(
    rowAgent({ ...gooseRow(200_000), harness: 'codex' }).env?.(
      job('review-lens').contextTokens,
      null,
      reading,
    ),
  ).not.toHaveProperty('GOOSE_MAX_TURNS')
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
