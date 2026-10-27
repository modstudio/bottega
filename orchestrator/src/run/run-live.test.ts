import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { FAILS_OVER } from '../failure/failure.ts'
import { deriveLiveOutcome } from '../live-outcome.ts'
import { decideOutcome } from '../outcome.ts'
import { decideFailover } from '../route/failover.ts'
import { candidates, isRoutingEvidence, pick } from '../route/route.ts'
import { composeCodexThrottleNotice } from '../transport/codex-throttle.ts'
import { replyFileFallbackError } from './run-live.ts'
import { firstThrottleObserver } from './run-throttle.ts'

test('a missing reply file leaves a visible final-message fallback notice', () => {
  const path = '/var/tmp/orch/runs/42/scratch/reply.json'
  expect(replyFileFallbackError(path, false, null)).toBe(
    `reply.json missing at ${path}; used final-message fallback`,
  )
  expect(replyFileFallbackError(path, true, null)).toBeNull()
})

test('a missing reply at the launched turn ceiling names the ceiling; below it or without a ceiling does not', () => {
  const path = '/var/tmp/orch/runs/42/scratch/reply.json'
  expect(replyFileFallbackError(path, false, null, 150, 150)).toBe(
    `reply.json missing at ${path}; used final-message fallback; the run stopped at the Goose turn ceiling (150)`,
  )
  expect(replyFileFallbackError(path, false, null, 149, 150)).toBe(
    `reply.json missing at ${path}; used final-message fallback`,
  )
  expect(replyFileFallbackError(path, false, null, 500, null)).toBe(
    `reply.json missing at ${path}; used final-message fallback`,
  )
})

test('the first live throttle cancels exactly once', () => {
  let cancellations = 0
  const throttle = firstThrottleObserver(() => cancellations++)
  const event = {
    kind: 'throttled' as const,
    attempt: 1,
    max: 5,
    retryDelayMs: 225_000,
    retryAt: '2026-10-21T20:03:45.000Z',
    httpStatus: 429 as const,
  }
  throttle.observe(event)
  throttle.observe({ ...event, attempt: 2 })
  expect(cancellations).toBe(1)
  expect(throttle.state.first).toEqual(event)
})

test('a live first throttle closes as quota and routes away from cooling codex', async () => {
  const id = addRun({ agent: 'codex', job: 'file-question', status: 'running' })
  let cancelled = false
  const transport = {
    async *events() {
      yield {
        kind: 'throttled' as const,
        attempt: 1,
        max: 5,
        retryDelayMs: 225_000,
        retryAt: '2026-10-21T20:03:45.000Z',
        httpStatus: 429 as const,
      }
    },
    cancel() {
      cancelled = true
    },
  }
  const throttle = firstThrottleObserver(() => transport.cancel())
  for await (const event of transport.events()) throttle.observe(event)
  expect(cancelled).toBe(true)

  const error = composeCodexThrottleNotice(throttle.state.first!)
  const derived = deriveLiveOutcome({
    writesJob: false,
    contractStatus: null,
    replyError: error,
    output: '',
    replyFilePresent: false,
    replyFileError: null,
    transportName: 'cli',
    transportStatus: 'failed',
    transportStopReason: 'cancelled',
    transportError: 'cancelled',
    transportFailureKind: null,
    collectedAsking: false,
    acceptedQuestions: false,
    idleKilled: false,
    idleKillError: null,
    outputCeilingReached: false,
    outputCeilingStopReason: 'max_tokens',
    timedOut: false,
    stderr: '',
    stdout: '',
    exitCode: 143,
    signal: 'SIGTERM',
    sandbox: 'host',
    boundMs: 20 * 60_000,
    agentName: 'codex',
  })
  const outcome = decideOutcome(derived.inputs)
  expect(outcome).toEqual({ status: 'failed', failureKind: 'quota' })
  db()
    .query('UPDATE run SET status=?, failure_kind=?, error=?, latency_ms=? WHERE record_id=?')
    .run(outcome.status, outcome.failureKind, error, 1_000, id)

  expect(isRoutingEvidence({ status: 'failed', delivery: null, failureKind: 'quota' })).toBe(false)
  expect(
    candidates('file-question').find((candidate) => candidate.agent === 'codex'),
  ).toMatchObject({ cooling: expect.stringContaining('quota'), failures: 0, evidence: 0 })

  const successor = pick('file-question', undefined, 10, false, undefined, { agents: ['codex'] })
  expect(successor.agent).not.toBe('codex')
  expect(
    decideFailover({
      status: outcome.status,
      failureKind: outcome.failureKind,
      failoverKinds: FAILS_OVER,
      noFailover: false,
      writesJob: false,
      changes: { files: [] },
      worktree: '(none — read-only job)',
      attemptCount: 1,
      maxAttempts: 3,
      agentsTried: ['codex'],
      originalPromptAvailable: true,
      successor,
    }),
  ).toEqual({ kind: 'successor', agent: successor.agent })
})
