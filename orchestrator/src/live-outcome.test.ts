import { describe, expect, test } from 'bun:test'
import { deriveLiveOutcome, type LiveOutcomeFacts } from './live-outcome.ts'
import { decideOutcome } from './outcome.ts'

const base: LiveOutcomeFacts = {
  writesJob: true,
  contractStatus: null,
  replyError: null,
  output: 'useful answer',
  replyFilePresent: false,
  replyFileError: null,
  transportName: 'cli',
  transportStatus: 'ok',
  transportStopReason: null,
  transportError: null,
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
  exitCode: 0,
  sandbox: 'host',
  boundMs: 45 * 60_000,
  agentName: 'worker',
}

const outcome = (facts: Partial<LiveOutcomeFacts>) => {
  const derived = deriveLiveOutcome({ ...base, ...facts })
  return { ...decideOutcome(derived.inputs), error: derived.error }
}

describe('live outcome derivation', () => {
  test('a completed reply outranks an idle kill', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        idleKilled: true,
        idleKillError: 'idle-killed after 10m with no CPU',
        transportStatus: 'failed',
        transportStopReason: 'cancelled',
      }),
    ).toEqual({ status: 'ok', failureKind: null, error: null })
  })

  test.each(['acp', 'cli'])('an idle kill outranks a %s transport cancel', (transportName) => {
    expect(
      outcome({
        transportName,
        transportStatus: 'failed',
        transportStopReason: 'cancelled',
        transportError: 'the turn was cancelled',
        idleKilled: true,
        idleKillError: 'idle-killed after 10m with no CPU',
      }),
    ).toEqual({
      status: 'failed',
      failureKind: 'idle',
      error: 'idle-killed after 10m with no CPU',
    })
  })

  test('a valid reply file present at timeout is completed work', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        timedOut: true,
        exitCode: 143,
      }),
    ).toEqual({ status: 'ok', failureKind: null, error: null })
  })

  test('a non-answer with exit code zero is a failure', () => {
    expect(outcome({ writesJob: false, output: '[API Error: empty response]' })).toEqual({
      status: 'failed',
      failureKind: 'other',
      error: '[API Error: empty response]',
    })
  })

  test('a non-zero exit with no stdout records the stderr tail ahead of the reply notice', () => {
    const stderr = 'Session not found locally for session abc\nRequest failed with status 404'
    const replyNotice = 'reply did not match the worker contract:\n'
    expect(
      outcome({
        exitCode: 1,
        stdout: '',
        output: '',
        stderr,
        replyFileError: replyNotice,
        replyFilePresent: false,
        contractStatus: null,
      }),
    ).toEqual({
      status: 'failed',
      failureKind: 'other',
      error: `${stderr}\n${replyNotice.trimEnd()}`,
    })
  })
})
