import { describe, expect, test } from 'bun:test'
import { resolveReplyDialect } from './contract/contract.ts'
import { COOLS_DOWN, FAILS_OVER, NOT_EVIDENCE } from './failure/failure.ts'
import { job } from './jobs/jobs.ts'
import {
  composeCompletedReplyEndedError,
  deriveLiveOutcome,
  LAST_VENDOR_EVENT_TYPE_MAX,
  type LiveOutcomeFacts,
} from './live-outcome.ts'
import { decideOutcome } from './outcome.ts'
import { decideFailover } from './route/failover.ts'
import { collectReplySource, type ReplyContract } from './run/run-reply-source.ts'
import { composeCodexThrottleNotice } from './transport/codex-throttle.ts'

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
    const error = composeCodexThrottleNotice({ attempt: 1, max: 5 })
    expect(
      outcome({
        replyError: error,
        output: '',
        exitCode: 143,
        signal: 'SIGTERM',
      }),
    ).toEqual({
      status: 'failed',
      failureKind: 'quota',
      error,
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

  test('goose provider error reply is a provider failure despite the sandbox banner', () => {
    const reply =
      'sandbox host: MCP was requested; srt blocks MCP transports; run is unconfined\n\n' +
      'Ran into this error: Request failed: Bad request (400): Provider returned error.\n\n' +
      'Please retry if you think this is a transient or recoverable error.'
    expect(outcome({ writesJob: false, output: reply })).toEqual({
      status: 'failed',
      failureKind: 'provider_error',
      error: reply.trim(),
    })
  })

  test('billing wording in a goose provider error envelope stays billing', () => {
    expect(
      outcome({
        writesJob: false,
        output:
          'Ran into this error: Request failed: Bad request (400): Please check your account with your provider to add more credits.',
      }).failureKind,
    ).toBe('billing')
  })

  test('a review that quotes Request failed is still an answer', () => {
    const review = 'Finding: the log says `Request failed:` but the retry path silently ignores it.'
    expect(outcome({ writesJob: false, output: review }).status).toBe('ok')
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
      failureKind: 'contract',
      error: `${stderr}\n${replyNotice.trimEnd()}`,
    })
  })
})

const readerReply = JSON.stringify({
  deliverables: [],
  narrative: 'The requested survey is complete.',
  files_written: null,
})
const textReply = JSON.stringify({ answer: 'The requested answer is complete.' })
const customSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['count'],
  properties: { count: { type: 'number' } },
} as const
const customReply = JSON.stringify({ count: 2 })

function composedFallbackDecision(input: {
  contract: ReplyContract
  fallbackText: string
  dialect: ReturnType<typeof resolveReplyDialect>
  schema: unknown
  writesJob?: boolean
}) {
  const source = collectReplySource({
    replyFileText: null,
    fallbackText: input.fallbackText,
    contract: input.contract,
    dialect: input.dialect,
    schema: input.schema,
  })
  const parsed = input.writesJob ? input.dialect.parse(source.output).reply : null
  const derived = deriveLiveOutcome({
    ...base,
    writesJob: input.writesJob ?? false,
    contractStatus:
      parsed && typeof parsed === 'object' && 'status' in parsed
        ? ((parsed as { status: 'done' | 'asking' | 'refused' }).status ?? null)
        : null,
    output: source.output,
    replyFilePresent: source.replyFilePresent,
    replyFileError: source.replyFileError,
  })
  const result = decideOutcome(derived.inputs)
  const failover = decideFailover({
    status: result.status,
    failureKind: result.failureKind,
    failoverKinds: FAILS_OVER,
    noFailover: false,
    chainRoot: null,
    writesJob: false,
    changes: { files: [] },
    worktree: '(none — read-only job)',
    attemptCount: 1,
    maxAttempts: 3,
    agentsTried: ['worker'],
    originalPromptAvailable: true,
  })
  return { ...result, failover: failover.kind }
}

describe('final-message fallback contract composition', () => {
  const readerDialect = resolveReplyDialect(job('understand'))
  const textDialect = resolveReplyDialect(job('summarize'))
  const writerDialect = resolveReplyDialect(job('implement'))
  test.each([
    {
      name: 'none contract rejects a prose preamble',
      contract: 'none' as const,
      fallbackText: "I'll start by reading the task definitions and relevant implementation.",
      dialect: readerDialect,
      schema: readerDialect.schema,
      expected: { status: 'failed', failureKind: 'contract', failover: 'select' },
    },
    {
      name: 'none contract accepts a reader reply',
      contract: 'none' as const,
      fallbackText: readerReply,
      dialect: readerDialect,
      schema: readerDialect.schema,
      expected: { status: 'ok', failureKind: null, failover: 'none' },
    },
    {
      name: 'text contract rejects a prose preamble',
      contract: 'text' as const,
      fallbackText: 'I will summarize the requested material next.',
      dialect: textDialect,
      schema: textDialect.schema,
      expected: { status: 'failed', failureKind: 'contract', failover: 'select' },
    },
    {
      name: 'text contract accepts its answer object',
      contract: 'text' as const,
      fallbackText: textReply,
      dialect: textDialect,
      schema: textDialect.schema,
      expected: { status: 'ok', failureKind: null, failover: 'none' },
    },
    {
      name: 'custom contract rejects a prose preamble',
      contract: 'custom' as const,
      fallbackText: 'I will count the requested records next.',
      dialect: textDialect,
      schema: customSchema,
      expected: { status: 'failed', failureKind: 'contract', failover: 'select' },
    },
    {
      name: 'custom contract accepts its schema instance',
      contract: 'custom' as const,
      fallbackText: customReply,
      dialect: textDialect,
      schema: customSchema,
      expected: { status: 'ok', failureKind: null, failover: 'none' },
    },
    {
      name: 'run 24956 reader preamble is a contract failure',
      contract: 'none' as const,
      fallbackText: "I'll start by reading the task definitions and current implementation.",
      dialect: readerDialect,
      schema: readerDialect.schema,
      expected: { status: 'failed', failureKind: 'contract', failover: 'select' },
    },
    {
      name: 'run 25006 text preamble and compaction error is a contract failure',
      contract: 'text' as const,
      fallbackText:
        "I'll start by reading the task.\nRan into this error trying to compact: Server error: Upstream error from Inception",
      dialect: textDialect,
      schema: textDialect.schema,
      expected: { status: 'failed', failureKind: 'contract', failover: 'select' },
    },
    {
      name: 'goose provider error keeps its provider classification',
      contract: 'none' as const,
      fallbackText:
        'Ran into this error: Request failed: Bad request (400): Provider returned error.\n\n' +
        'Please retry if you think this is a transient or recoverable error.',
      dialect: readerDialect,
      schema: readerDialect.schema,
      expected: { status: 'failed', failureKind: 'provider_error', failover: 'select' },
    },
    {
      name: 'writer with no reply is a contract failure',
      contract: 'none' as const,
      fallbackText: '',
      dialect: writerDialect,
      schema: writerDialect.schema,
      writesJob: true,
      expected: { status: 'failed', failureKind: 'contract', failover: 'select' },
    },
  ])('$name', ({ expected, ...input }) => {
    expect(composedFallbackDecision(input)).toEqual(expected)
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
