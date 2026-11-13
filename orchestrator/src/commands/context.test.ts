import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { run } from '../cli/program.ts'
import type { ContextCensus } from '../doc/context-census.ts'
import { getContextItem } from '../doc/context-item-store.ts'
import { renderContextCensus } from './context.ts'

test('context census renderer preserves grouping, counts, remedies, and one verdict line', () => {
  const report: ContextCensus = {
    since: '2026-11-05T00:00:00Z',
    projects: [
      {
        project: PLATFORM_SLUG,
        covered: 0,
        total: 1,
        sessions: [
          {
            session: 'architect',
            lastSeen: '2026-11-12T00:00:00Z',
            covered: 0,
            total: 1,
            noHolder: false,
            tasks: [
              {
                key: 'DEV-1',
                project: PLATFORM_SLUG,
                title: 'Task',
                status: 'unreadable',
                closed: false,
                covered: 0,
                total: 1,
                firstWorkedAt: '2026-11-10T00:00:00Z',
                lastWorkedAt: '2026-11-11T00:00:00Z',
                nextActionAt: null,
                openQuestions: 1,
                rulings: 2,
                sources: [{ source: 'q9', writingVerb: true }],
                remedy: 'retry the task read',
              },
            ],
          },
        ],
      },
    ],
    verdict: {
      full: false,
      uncovered: [],
      unreadable: [{ task: 'DEV-1', remedy: 'retry the task read' }],
    },
  }
  expect(renderContextCensus(report).split('\n')).toEqual([
    `${PLATFORM_SLUG}  0/1`,
    '  architect  0/1',
    '    DEV-1  0/1  unreadable  retry the task read  open 1  rulings 2  sources q9:verb',
    'not full: 0 uncovered, 1 unreadable',
    '  unreadable DEV-1: retry the task read',
  ])
})

test('agent context set refuses matching record shapes without writing', async () => {
  const errors: string[] = []
  const error = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
  const session = newRecordId()
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    const cases = [
      {
        kind: 'ruling',
        body: 'x'.repeat(1501),
        refusal: 'ruling is 1501 characters; the limit is 1500 (RULING_MAX_CHARS)',
      },
      {
        kind: 'open-question',
        body: 'first\n\nsecond',
        refusal: 'open question must be one paragraph with no blank line',
      },
      {
        kind: 'next-action',
        body: 'first\nsecond',
        refusal: 'next action must be one line',
      },
    ]
    for (const { kind, body, refusal } of cases) {
      const source = kind === 'ruling' ? 'q1' : 'test'
      expect(
        await run([
          'context',
          'set',
          '--session',
          session,
          '--kind',
          kind,
          '--source',
          source,
          '--id',
          'shape',
          body,
        ]),
      ).toBe(1)
      expect(errors.at(-1)).toContain(refusal)
      expect(getContextItem(`session:${session}`, 'shape')).toBeNull()
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
    error.mockRestore()
  }
})
