import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { measureSessionLosses, type TranscriptRow } from './session-losses.ts'

const stamp = (second: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, second)).toISOString()
const usage = (input = 1, cacheRead = 2, cacheCreation = 3, output = 4) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
  output_tokens: output,
})
const assistant = (
  second: number,
  id: string,
  tokens = usage(),
  content: unknown = [{ type: 'text', text: id }],
): TranscriptRow => ({
  type: 'assistant',
  timestamp: stamp(second),
  message: { id, usage: tokens, content },
})
const boundary = (second: number): TranscriptRow => ({
  type: 'system',
  subtype: 'compact_boundary',
  timestamp: stamp(second),
  compactMetadata: { preTokens: 100, postTokens: 20, trigger: 'auto' },
})
const emptyFacts = () => ({ runs: [], cursors: [], claims: [], unjudgedOwnerWindowMs: 1_000 })
const tool = (second: number, id: string, name: string, input: unknown) =>
  assistant(second, id, usage(), [{ type: 'tool_use', name, input }])

describe('compaction segmentation', () => {
  test('excludes the compact summary and deduplicates assistant turns by message id', () => {
    const report = measureSessionLosses(
      'session',
      [
        assistant(0, 'repeat', usage(100, 0, 0, 0)),
        assistant(1, 'repeat'),
        boundary(2),
        {
          type: 'user',
          timestamp: stamp(3),
          isCompactSummary: true,
          message: { content: 'summary' },
        },
        assistant(4, 'after'),
      ],
      emptyFacts(),
    )!
    expect(report.boundaries[0]).toMatchObject({
      preTokens: 100,
      postTokens: 20,
      trigger: 'auto',
      before: { turns: 1, mean: 10, p90: 10 },
      after: { turns: 1, mean: 10, p90: 10 },
    })
    expect(report.boundaries[0]!.candidates.earlierTurns).toEqual([
      { role: 'assistant', at: stamp(1), text: 'repeat' },
    ])
  })

  test('ends a loss collection window at the next boundary', () => {
    const report = measureSessionLosses(
      'session',
      [
        assistant(0, 'before'),
        boundary(1),
        assistant(2, 'middle'),
        boundary(3),
        tool(4, 'collected', 'Bash', { command: `${PLATFORM_SLUG} run result 42` }),
      ],
      {
        ...emptyFacts(),
        runs: [{ id: 'run-id', number: 42, startedAt: stamp(0), terminalAt: null }],
      },
    )!
    expect(report.boundaries[0]!.lost.runs).toEqual({ count: 1, ids: ['run-id'] })
    expect(report.boundaries[1]!.lost.runs).toEqual({ count: 0, ids: [] })
  })
})

describe('run loss', () => {
  const transcript = (collect: boolean) => [
    assistant(0, 'before'),
    boundary(2),
    collect
      ? tool(3, 'after', 'Bash', { command: `${PLATFORM_SLUG} run wait run-open` })
      : assistant(3, 'after'),
    assistant(5, 'end'),
  ]

  test('does not lose an open run collected after the boundary', () => {
    const report = measureSessionLosses('session', transcript(true), {
      ...emptyFacts(),
      runs: [{ id: 'run-open', number: 9, startedAt: stamp(0), terminalAt: stamp(4) }],
    })!
    expect(report.boundaries[0]!.lost.runs.count).toBe(0)
  })

  test('loses an open run that is never collected', () => {
    const report = measureSessionLosses('session', transcript(false), {
      ...emptyFacts(),
      runs: [{ id: 'run-open', number: 9, startedAt: stamp(0), terminalAt: stamp(4) }],
    })!
    expect(report.boundaries[0]!.lost.runs.ids).toEqual(['run-open'])
  })

  test('does not count a run terminal before the boundary', () => {
    const report = measureSessionLosses('session', transcript(false), {
      ...emptyFacts(),
      runs: [{ id: 'run-done', number: 9, startedAt: stamp(0), terminalAt: stamp(1) }],
    })!
    expect(report.boundaries[0]!.lost.runs.count).toBe(0)
  })
})

describe('claim pointer loss', () => {
  const claim = (takenAt = stamp(0), closedAt: string | null = null) => ({
    id: 'claim-id',
    subject: 'DEV-1854',
    takenAt,
    closedAt,
  })
  const report = (after: TranscriptRow[], fact = claim()) =>
    measureSessionLosses(
      'session',
      [assistant(0, 'before'), boundary(2), ...after, assistant(5, 'end')],
      {
        ...emptyFacts(),
        claims: [fact],
      },
    )!

  test('a claim renewed in transcript tool input is not lost', () => {
    expect(
      report([
        tool(3, 'renew', 'Bash', {
          command: `${PLATFORM_SLUG} board claim renew claim-id # DEV-1854`,
        }),
      ]).boundaries[0]!.lost.claims.count,
    ).toBe(0)
  })

  test('a claim closed in the window is not lost', () => {
    expect(
      report([assistant(3, 'after')], claim(stamp(0), stamp(4))).boundaries[0]!.lost.claims.count,
    ).toBe(0)
  })

  test('an untouched claim is lost', () => {
    expect(report([assistant(3, 'after')]).boundaries[0]!.lost.claims.ids).toEqual(['claim-id'])
  })

  test('a claim taken after the boundary is not counted', () => {
    expect(report([assistant(3, 'after')], claim(stamp(3))).boundaries[0]!.lost.claims.count).toBe(
      0,
    )
  })
})

test('candidate payload is blind and Claude token splits sum to total', () => {
  const report = measureSessionLosses(
    'session',
    [
      assistant(0, 'before', usage(10, 20, 30, 40)),
      boundary(1),
      tool(3, 'question', 'SendMessage', { message: 'Still true?' }),
      assistant(3_603, 'end'),
    ],
    emptyFacts(),
  )!
  expect(JSON.stringify(report.boundaries[0]!.candidates)).not.toContain('arm')
  expect(report.boundaries[0]!.candidates.candidates).toHaveLength(1)
  expect(report.costPerSessionHour).toBe('subscription, unpriced')
  expect(report.tokens.total).toBe(
    report.tokens.input +
      report.tokens.cacheRead +
      report.tokens.cacheCreation +
      report.tokens.output,
  )
  expect(report.tokensPerSessionHour.total).toBe(
    report.tokensPerSessionHour.input +
      report.tokensPerSessionHour.cacheRead +
      report.tokensPerSessionHour.cacheCreation +
      report.tokensPerSessionHour.output,
  )
})
