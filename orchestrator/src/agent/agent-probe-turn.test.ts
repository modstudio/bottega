import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/preload.ts'
import { db } from '../database/db.ts'
import { readEventLog, runEventsPath } from '../events.ts'
import type {
  AgentTransport,
  TransportHandle,
  TransportResult,
  TransportStartOpts,
} from '../transport/transport.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import { probeEnvironment, runProbeTurn } from './agent-probe-turn.ts'
import { BUILTIN_AGENTS } from './agents.ts'

const quotaReadings = {
  quotaUsedPercentStart: 12,
  quotaUsedPercentEnd: 13,
  quotaWindowMinutes: 10_080,
  quotaResetsAt: 1_800_000_000,
}

const originalHome = process.env.HOME
const originalCodexHome = process.env.CODEX_HOME

function restoreProbeHomeEnvironment(): void {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
}

function releaseProbeHomeFixtures(): void {
  for (const name of ['operator-home', 'probe-scratch'])
    rmSync(join(dir, name), { recursive: true, force: true })
}

describe('probe environment quota rollout home', () => {
  afterEach(() => {
    restoreProbeHomeEnvironment()
    releaseProbeHomeFixtures()
  })

  describe('without an explicit CODEX_HOME', () => {
    const operatorHome = join(dir, 'operator-home')
    beforeEach(() => {
      mkdirSync(join(operatorHome, '.codex'), { recursive: true })
      writeFileSync(join(operatorHome, '.codex', 'auth.json'), '{}')
      writeFileSync(join(operatorHome, '.codex', 'config.toml'), '')
      process.env.HOME = operatorHome
      delete process.env.CODEX_HOME
    })

    test('confines CODEX_HOME under the probe scratch directory for a codex harness', async () => {
      const scratch = join(dir, 'probe-scratch')
      const environment = await probeEnvironment(
        'codex',
        { ...BUILTIN_AGENTS.codex!, harness: 'codex' },
        scratch,
      )

      expect(environment.CODEX_HOME).toBe(join(scratch, 'codex'))
    })

    test('does not add CODEX_HOME for a non-codex harness', async () => {
      const environment = await probeEnvironment(
        'grok',
        { ...BUILTIN_AGENTS.grok!, harness: 'grok' },
        dir,
      )

      expect(environment.CODEX_HOME).toBeUndefined()
    })
  })

  describe('with an explicit CODEX_HOME', () => {
    beforeEach(() => {
      process.env.HOME = '/operator'
      process.env.CODEX_HOME = '/explicit/codex'
    })

    test('keeps the explicit home for a codex harness', async () => {
      const environment = await probeEnvironment(
        'codex',
        { ...BUILTIN_AGENTS.codex!, harness: 'codex' },
        dir,
      )

      expect(environment.CODEX_HOME).toBe('/explicit/codex')
    })
  })
})

function collectedResult(status: 'ok' | 'failed' = 'ok'): TransportResult {
  const failed = status === 'failed'
  return {
    output: failed ? 'quota exhausted' : 'ok',
    stdout: '',
    stderr: '',
    raw: '',
    parsed: null,
    tokens: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    quotaReadings,
    sessionId: null,
    stopReason: failed ? 'error' : 'end_turn',
    error: failed ? 'quota exhausted' : null,
    exitCode: failed ? 1 : 0,
    pid: null,
    events: [],
    asking: false,
    failureKind: failed ? 'quota' : null,
    status,
    questions: [],
  }
}

function probeTransport(status: 'ok' | 'failed' = 'ok'): AgentTransport {
  const handle: TransportHandle = {
    pid: null,
    kill() {},
    prompt: async () => {},
    async *events() {},
    cancel: async () => {},
    collect: async () => collectedResult(status),
  }
  return {
    name: 'cli',
    canInjectMidTurn: false,
    configuredAsk: () => null,
    start: async () => handle,
    prompt: (turn, text) => turn.prompt(text),
    events: (turn) => turn.events(),
    cancel: (turn) => turn.cancel(),
    resume: async () => handle,
  }
}

test("a probe turn's environment reaches transport start and overrides the agent value", async () => {
  const base = probeTransport('ok')
  let started: TransportStartOpts | null = null
  const capturing: AgentTransport = {
    ...base,
    start: async (opts) => {
      started = opts
      return base.start(opts)
    },
  }

  await runProbeTurn({
    name: 'grok',
    scratch: dir,
    agent: { ...BUILTIN_AGENTS.grok!, env: () => ({ PROBE_OVERRIDE: 'agent' }) },
    transport: capturing,
    id: 'environment-override',
    prompt: 'probe',
    environment: { PROBE_OVERRIDE: 'turn' },
  })

  expect(started?.env.PROBE_OVERRIDE).toBe('turn')
})

test.each(['ok', 'failed'] as const)(
  'a collected %s probe turn persists its quota reading',
  async (status) => {
    await runProbeTurn({
      name: 'codex',
      scratch: dir,
      agent: BUILTIN_AGENTS.codex!,
      transport: probeTransport(status),
      id: `quota-reading-${status}`,
      prompt: 'report quota',
    })

    expect(
      db()
        .query(
          `SELECT quota_used_percent_start, quota_used_percent_end,
                  quota_window_minutes, quota_resets_at
             FROM run WHERE job=?`,
        )
        .get(`agent-probe-quota-reading-${status}`),
    ).toEqual({
      quota_used_percent_start: quotaReadings.quotaUsedPercentStart,
      quota_used_percent_end: quotaReadings.quotaUsedPercentEnd,
      quota_window_minutes: quotaReadings.quotaWindowMinutes,
      quota_resets_at: quotaReadings.quotaResetsAt,
    })
  },
)

test('a probe warning is recorded against the probe run row', async () => {
  const base = probeTransport('ok')
  const capturing: AgentTransport = {
    ...base,
    start: async (opts) => {
      opts.onWarning?.('codex rollout slice dropped')
      return base.start(opts)
    },
  }
  await runProbeTurn({
    name: 'grok',
    scratch: dir,
    agent: BUILTIN_AGENTS.grok!,
    transport: capturing,
    id: 'warning-sink',
    prompt: 'probe',
  })

  const row = db()
    .query(`SELECT record_id FROM run WHERE job=?`)
    .get('agent-probe-warning-sink') as { record_id: string }
  expect(
    readEventLog(runEventsPath(row.record_id)).some(
      (event) => event.type === 'warning' && event.text.includes('codex rollout slice dropped'),
    ),
  ).toBe(true)
})

test('a refused codex probe environment records a failed turn, not a running row', async () => {
  const operatorHome = join(dir, 'operator-home-refused')
  const scratch = join(dir, 'probe-scratch-refused')
  mkdirSync(join(operatorHome, '.codex'), { recursive: true })
  process.env.HOME = operatorHome
  delete process.env.CODEX_HOME
  try {
    const result = await runProbeTurn({
      name: 'codex',
      scratch,
      agent: { ...BUILTIN_AGENTS.codex!, harness: 'codex' },
      transport: probeTransport('ok'),
      id: 'refused-home',
      prompt: 'report quota',
    })

    expect(result.status).toBe('failed')
    const row = db()
      .query(`SELECT status, error FROM run WHERE job=?`)
      .get('agent-probe-refused-home') as { status: string; error: string | null }
    expect(row.status).toBe('failed')
    expect(row.status).not.toBe('running')
    expect(row.error).toContain('auth.json')
  } finally {
    restoreProbeHomeEnvironment()
    rmSync(operatorHome, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})
