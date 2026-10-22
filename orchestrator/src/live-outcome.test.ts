import { describe, expect, test } from 'bun:test'
import { COOLS_DOWN, FAILS_OVER, NOT_EVIDENCE } from './failure/failure.ts'
import {
  composeCompletedReplyEndedError,
  deriveLiveOutcome,
  LAST_VENDOR_EVENT_TYPE_MAX,
  type LiveOutcomeFacts,
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
  test('a first-throttle cancellation remains quota rather than interruption', () => {
    expect(
      outcome({
        replyError: 'Codex throttled: 429 Too Many Requests (retry 1/5)',
        output: '',
        exitCode: 143,
        signal: 'SIGTERM',
      }),
    ).toEqual({
      status: 'failed',
      failureKind: 'quota',
      error: 'Codex throttled: 429 Too Many Requests (retry 1/5)',
    })
    expect(FAILS_OVER).toContain('quota')
    expect(COOLS_DOWN).toContain('quota')
    expect(NOT_EVIDENCE).toContain('quota')
  })

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
  `the worker wrote a done-shaped reply, then the process ended ` +
  `(exit ${exitCode}) before the run finished. ` +
  `Its work so far is in the worktree; read the diff and resume.`

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
    {
      name: 'a secret-shaped type is withheld',
      facts: {
        exitCode: 1,
        failoverTerminal: '',
        signal: null,
        lastVendorEventType: 'token=not-a-real-secret',
        stderr: '',
      },
      expected: `${endedNotice(1)}\nlast vendor event: [withheld: secret-shaped content]`,
    },
    {
      name: 'a multiline type is omitted',
      facts: {
        exitCode: 1,
        failoverTerminal: '',
        signal: null,
        lastVendorEventType: 'error\nitem.completed',
        stderr: '',
      },
      expected: endedNotice(1),
    },
    {
      name: 'an oversized type is cut and marked',
      facts: {
        exitCode: 1,
        failoverTerminal: '',
        signal: null,
        lastVendorEventType: `${'x'.repeat(LAST_VENDOR_EVENT_TYPE_MAX)}overflow`,
        stderr: '',
      },
      expected: `${endedNotice(1)}\nlast vendor event: ${'x'.repeat(LAST_VENDOR_EVENT_TYPE_MAX)}…`,
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

  test.each([
    ['message', '{"type":"error","message":"turn aborted"}\n'],
    ['error', '{"type":"error","error":"turn aborted"}\n'],
  ])('the last stdout JSONL event records its top-level %s', (_, stdout) => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout,
        stderr: '',
        signal: null,
      }).error,
    ).toBe(`${endedNotice(1)}\nlast vendor event: error\nvendor error: turn aborted`)
  })

  test('a turn.failed event records its nested error message', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout: '{"type":"turn.failed","error":{"message":"thread x not found"}}\n',
        stderr: '',
        signal: null,
      }).error,
    ).toBe(
      `${endedNotice(1)}\n` +
        `last vendor event: turn.failed\n` +
        `vendor error: thread x not found`,
    )
  })

  test('a secret-shaped vendor error is withheld', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout: '{"type":"turn.failed","error":{"message":"token=not-a-real-secret"}}\n',
        stderr: '',
        signal: null,
      }).error,
    ).toBe(
      `${endedNotice(1)}\n` +
        `last vendor event: turn.failed\n` +
        `vendor error: [withheld: secret-shaped content]`,
    )
  })

  test('a last event with no error message adds no vendor error line', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout: '{"type":"turn.failed","error":{"code":"transport_error"}}\n',
        stderr: '',
        signal: null,
      }).error,
    ).toBe(`${endedNotice(1)}\nlast vendor event: turn.failed`)
  })

  test('a non-JSON final stdout line does not reuse an earlier vendor event', () => {
    expect(
      outcome({
        contractStatus: 'done',
        replyFilePresent: true,
        exitCode: 1,
        stdout: '{"type":"turn.failed","error":{"message":"stale failure"}}\nnot-json\n',
        stderr: '',
        signal: null,
      }).error,
    ).toBe(endedNotice(1))
  })
})
