import { expect, test } from 'bun:test'
import { dir } from '../../test/preload.ts'
import { db } from '../database/db.ts'
import type { AgentTransport, TransportHandle, TransportResult } from '../transport/transport.ts'
import { EMPTY_VENDOR_USAGE } from '../transport/vendor-usage.ts'
import { runProbeTurn } from './agent-probe-turn.ts'
import { BUILTIN_AGENTS } from './agents.ts'

const quotaReadings = {
  quotaUsedPercentStart: 12,
  quotaUsedPercentEnd: 13,
  quotaWindowMinutes: 10_080,
  quotaResetsAt: 1_800_000_000,
}

function collectedResult(): TransportResult {
  return {
    output: 'ok',
    stdout: '',
    stderr: '',
    raw: '',
    parsed: null,
    tokens: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    quotaReadings,
    sessionId: null,
    stopReason: 'end_turn',
    error: null,
    exitCode: 0,
    pid: null,
    events: [],
    asking: false,
    failureKind: null,
    status: 'ok',
    questions: [],
  }
}

function probeTransport(): AgentTransport {
  const handle: TransportHandle = {
    pid: null,
    kill() {},
    prompt: async () => {},
    async *events() {},
    cancel: async () => {},
    collect: async () => collectedResult(),
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

test('a collected probe turn persists its quota reading', async () => {
  await runProbeTurn({
    name: 'codex',
    scratch: dir,
    agent: BUILTIN_AGENTS.codex!,
    transport: probeTransport(),
    id: 'quota-reading',
    prompt: 'report quota',
  })

  expect(
    db()
      .query(
        `SELECT quota_used_percent_start, quota_used_percent_end,
                quota_window_minutes, quota_resets_at
           FROM run WHERE job='agent-probe-quota-reading'`,
      )
      .get(),
  ).toEqual({
    quota_used_percent_start: quotaReadings.quotaUsedPercentStart,
    quota_used_percent_end: quotaReadings.quotaUsedPercentEnd,
    quota_window_minutes: quotaReadings.quotaWindowMinutes,
    quota_resets_at: quotaReadings.quotaResetsAt,
  })
})
