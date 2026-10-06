import { describe, expect, test } from 'bun:test'
import {
  composeCompletedReplyEndedError,
  deriveLiveOutcome,
  type LiveOutcomeFacts,
  lastStdoutJsonlType,
} from './live-outcome.ts'
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
  signal: null,
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

const endedNotice = (exitCode: number) =>
  `the worker completed and wrote its reply, then the process ended ` +
  `(exit ${exitCode}). Its work is in the worktree; resume or read the diff.`

describe('completed-reply process-ended error composition', () => {
  test.each([
    {
      name: 'exit 1 with stderr and stdout both present keeps the stderr tail',
      facts: {
        exitCode: 1,
        failoverTerminal: '',
        signal: null,
        lastVendorEventType: null,
        stderr: 'codex transport reset',
      },
      expected: `${endedNotice(1)}\nvendor stderr: codex transport reset`,
    },
    {
      name: 'a signal is named',
      facts: {
        exitCode: 143,
        failoverTerminal: '',
        signal: 'SIGTERM',
        lastVendorEventType: null,
        stderr: '',
      },
      expected: `${endedNotice(143)}\nsignal: SIGTERM`,
    },
    {
      name: 'nothing is added when none of the three facts exist',
      facts: {
        exitCode: 1,
        failoverTerminal: '',
        signal: null,
        lastVendorEventType: null,
        stderr: '',
      },
      expected: endedNotice(1),
    },
    {
      name: 'labels each present fact and withholds secret-shaped stderr',
      facts: {
        exitCode: 1,
        failoverTerminal: '',
        signal: 'SIGKILL',
        lastVendorEventType: 'error',
        stderr: 'token=not-a-real-secret',
      },
      expected:
        `${endedNotice(1)}\n` +
        `signal: SIGKILL\n` +
        `last vendor event: error\n` +
        `vendor stderr: [withheld: secret-shaped content]`,
    },
  ])('$name', ({ facts, expected }) => {
    expect(composeCompletedReplyEndedError(facts)).toBe(expected)
  })

  test('the classifier first sentence stays first when a failover terminal is present', () => {
    expect(
      composeCompletedReplyEndedError({
        exitCode: 1,
        failoverTerminal: 'quota exceeded',
        signal: 'SIGTERM',
        lastVendorEventType: 'item.completed',
        stderr: 'codex transport reset',
      }),
    ).toBe(
      `quota exceeded\n${endedNotice(1)}\n` +
        `signal: SIGTERM\n` +
        `last vendor event: item.completed\n` +
        `vendor stderr: codex transport reset`,
    )
  })
})

describe('last stdout JSONL type', () => {
  test.each([
    ['{"type":"item.completed"}\n', 'item.completed'],
    ['{"type":"error"}\nnot-json\n', null],
    ['not-json\n{"type":"error"}\n', 'error'],
    ['{"type":"turn.failed"}', 'turn.failed'],
    ['', null],
    ['[]\n', null],
    ['{"type":1}\n', null],
    ['{"no":"type"}\n', null],
  ])('%j → %j', (stdout, expected) => {
    expect(lastStdoutJsonlType(stdout)).toBe(expected)
  })
})

describe('completed-reply process-ended live outcome', () => {
  test('exit 1 with stderr and stdout both present records the stderr tail', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout: 'agent printed a reply\n',
        stderr: 'codex transport reset',
      }),
    ).toEqual({
      status: 'failed',
      failureKind: 'other',
      error: `${endedNotice(1)}\nvendor stderr: codex transport reset`,
    })
  })

  test('an unrecognized last stdout JSONL type is recorded without a timestamp', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout: '{"type":"error","message":"turn aborted"}\n',
        stderr: '',
        signal: null,
      }).error,
    ).toBe(`${endedNotice(1)}\nlast vendor event: error`)
  })
})
