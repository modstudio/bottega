import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  measureSessionLosses,
  structuredToolNamesRun,
  type TranscriptRow,
} from './session-losses.ts'

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

  test('reports absent boundary token metadata as null', () => {
    const compact = boundary(2)
    compact.compactMetadata = { trigger: 'manual' }
    const report = measureSessionLosses(
      'session',
      [assistant(0, 'before'), compact, assistant(3, 'after')],
      emptyFacts(),
    )!
    expect(report.boundaries[0]).toMatchObject({ preTokens: null, postTokens: null })
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

  test('does not count a failed run with no latency that ended before the boundary', () => {
    const report = measureSessionLosses('session', transcript(false), {
      ...emptyFacts(),
      runs: [{ id: 'run-failed', number: 9, startedAt: stamp(0), terminalAt: stamp(0) }],
    })!
    expect(report.boundaries[0]!.lost.runs.count).toBe(0)
  })

  test('counts a run left uncollected across boundaries only at the first boundary', () => {
    const report = measureSessionLosses(
      'session',
      [
        assistant(0, 'before'),
        boundary(1),
        assistant(2, 'one'),
        boundary(3),
        assistant(4, 'two'),
        boundary(5),
        assistant(6, 'three'),
      ],
      {
        ...emptyFacts(),
        runs: [{ id: 'run-open', number: 9, startedAt: stamp(0), terminalAt: null }],
      },
    )!
    expect(report.boundaries.map((item) => item.lost.runs.ids)).toEqual([['run-open'], [], []])
  })

  test('collects a terminal run during the owner grace window', () => {
    const report = measureSessionLosses(
      'session',
      [
        assistant(0, 'before'),
        boundary(2),
        tool(4, 'after', 'Bash', { command: `${PLATFORM_SLUG} run wait run-open` }),
        assistant(6, 'end'),
      ],
      {
        ...emptyFacts(),
        unjudgedOwnerWindowMs: 2_000,
        runs: [{ id: 'run-open', number: 9, startedAt: stamp(0), terminalAt: stamp(3) }],
      },
    )!
    expect(report.boundaries[0]!.lost.runs.count).toBe(0)
  })

  test('loses a terminal run collected after the owner grace window', () => {
    const report = measureSessionLosses(
      'session',
      [
        assistant(0, 'before'),
        boundary(2),
        tool(5, 'after', 'Bash', { command: `${PLATFORM_SLUG} run wait run-open` }),
        assistant(6, 'end'),
      ],
      {
        ...emptyFacts(),
        runs: [{ id: 'run-open', number: 9, startedAt: stamp(0), terminalAt: stamp(3) }],
      },
    )!
    expect(report.boundaries[0]!.lost.runs.ids).toEqual(['run-open'])
  })

  test.each([
    [['orch', 'result', '9559'].join(' '), 9559],
    [['orch', 'judge', '9558'].join(' '), 9558],
  ])('%s collects run %i', (command, number) => {
    const report = measureSessionLosses(
      'session',
      [assistant(0, 'before'), boundary(2), tool(3, 'after', 'Bash', { command })],
      {
        ...emptyFacts(),
        runs: [{ id: `run-${number}`, number, startedAt: stamp(0), terminalAt: null }],
      },
    )!
    expect(report.boundaries[0]!.lost.runs.count).toBe(0)
  })

  test.each([9559, '9559'])('an MCP run field of %p collects the run', (value) => {
    const run = { id: 'run-9559', number: 9559, startedAt: stamp(0), terminalAt: null }
    const runTool = { name: 'mcp__bottega__next_workflow_step', input: { run: value } }
    expect(structuredToolNamesRun(runTool, run)).toBe(true)
    const report = measureSessionLosses(
      'session',
      [assistant(0, 'before'), boundary(2), tool(3, 'after', runTool.name, runTool.input)],
      {
        ...emptyFacts(),
        runs: [run],
      },
    )!
    expect(report.boundaries[0]!.lost.runs.count).toBe(0)
  })

  test('free text in an MCP input does not collect the run', () => {
    const run = { id: 'run-9559', number: 9559, startedAt: stamp(0), terminalAt: null }
    const boardPost = { name: 'mcp__bottega__board_post', input: { body: 'Collected run 9559' } }
    expect(structuredToolNamesRun(boardPost, run)).toBe(false)
    const report = measureSessionLosses(
      'session',
      [assistant(0, 'before'), boundary(2), tool(3, 'after', boardPost.name, boardPost.input)],
      {
        ...emptyFacts(),
        runs: [run],
      },
    )!
    expect(report.boundaries[0]!.lost.runs.ids).toEqual(['run-9559'])
  })

  test('an older command does not collect a run whose number is only a prefix', () => {
    const report = measureSessionLosses(
      'session',
      [
        assistant(0, 'before'),
        boundary(2),
        tool(3, 'after', 'Bash', { command: ['orch', 'result', '95590'].join(' ') }),
      ],
      {
        ...emptyFacts(),
        runs: [{ id: 'run-9559', number: 9559, startedAt: stamp(0), terminalAt: null }],
      },
    )!
    expect(report.boundaries[0]!.lost.runs.ids).toEqual(['run-9559'])
  })
})

describe('cursor loss', () => {
  const report = (terminalAt: string | null, advancesAt: string[]) =>
    measureSessionLosses(
      'session',
      [assistant(0, 'before'), boundary(2), assistant(3, 'after'), assistant(5, 'end')],
      {
        ...emptyFacts(),
        cursors: [
          {
            id: 'cursor-id',
            number: 7,
            createdAt: stamp(0),
            terminalAt,
            advancesAt,
          },
        ],
      },
    )!

  test('loses a cursor never advanced inside the window', () => {
    expect(report(null, [stamp(6)]).boundaries[0]!.lost.cursors.ids).toEqual(['cursor-id'])
  })

  test('does not lose a cursor advanced inside the window', () => {
    expect(report(stamp(4), [stamp(4)]).boundaries[0]!.lost.cursors.count).toBe(0)
  })

  test('does not count a cursor terminal before the boundary', () => {
    expect(report(stamp(1), [stamp(1)]).boundaries[0]!.lost.cursors.count).toBe(0)
  })

  test('does not count a terminal cursor with no closing advance after it closed', () => {
    expect(report(stamp(1), []).boundaries[0]!.lost.cursors.count).toBe(0)
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

test('candidate payload excludes mechanical loss facts', () => {
  const report = measureSessionLosses(
    'session',
    [
      assistant(0, 'before', usage(10, 20, 30, 40)),
      boundary(1),
      tool(3, 'question', 'SendMessage', { message: 'Still true?' }),
      assistant(3_603, 'end'),
    ],
    {
      ...emptyFacts(),
      runs: [{ id: 'lost-run-secret', number: 91, startedAt: stamp(0), terminalAt: null }],
    },
  )!
  expect(JSON.stringify(report.boundaries[0]!.candidates)).not.toContain('lost-run-secret')
  expect(report.boundaries[0]!.candidates.candidates).toHaveLength(1)
})
