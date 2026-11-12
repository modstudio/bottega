import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { OPERATOR_SESSION_PREFIX } from '../../../shared/caller-classification.ts'
import {
  type ContextCensusTaskFact,
  censusVerdict,
  contextCensus,
  selectCensusProject,
} from './context-census.ts'

const since = '2026-11-05T00:00:00Z'
const session = {
  session: 'architect',
  lastSeen: '2026-11-12T00:00:00Z',
  project: PLATFORM_SLUG,
}
const work = (
  key: string,
  at = '2026-11-10T12:00:00Z',
  project: string | null = PLATFORM_SLUG,
) => ({
  session: 'architect',
  key,
  at,
  project,
})
const task = (key: string, input: Partial<ContextCensusTaskFact> = {}): ContextCensusTaskFact => ({
  key,
  project: PLATFORM_SLUG,
  title: key,
  statusCategory: 'active',
  items: [],
  unreadable: null,
  ...input,
})

describe('context census', () => {
  test('covers a task when next-action was revised at or after its first work', () => {
    const result = contextCensus({
      since,
      sessions: [session],
      work: [work('DEV-FRESH'), work('DEV-OLD'), work('DEV-MISSING')],
      tasks: [
        task('DEV-FRESH', {
          items: [
            { kind: 'next-action', source: 'workflow-next', updatedAt: '2026-11-10T12:00:00Z' },
          ],
        }),
        task('DEV-OLD', {
          items: [{ kind: 'next-action', source: 'hand', updatedAt: '2026-11-10T11:59:59Z' }],
        }),
        task('DEV-MISSING'),
      ],
    })
    expect(result.projects[0]!.sessions[0]!.tasks.map(({ key, status }) => [key, status])).toEqual([
      ['DEV-FRESH', 'covered'],
      ['DEV-MISSING', 'uncovered'],
      ['DEV-OLD', 'uncovered'],
    ])
    expect(result.verdict).toMatchObject({ full: false, uncovered: ['DEV-MISSING', 'DEV-OLD'] })
  })

  test('compares coverage to first work and reports the first and last work', () => {
    const result = contextCensus({
      since,
      sessions: [session],
      work: [
        work('DEV-BETWEEN', '2026-11-10T10:00:00Z'),
        work('DEV-BETWEEN', '2026-11-10T14:00:00Z'),
        work('DEV-OLDER', '2026-11-10T10:00:00Z'),
        work('DEV-OLDER', '2026-11-10T14:00:00Z'),
      ],
      tasks: [
        task('DEV-BETWEEN', {
          items: [
            { kind: 'next-action', source: 'workflow-next', updatedAt: '2026-11-10T12:00:00Z' },
          ],
        }),
        task('DEV-OLDER', {
          items: [
            { kind: 'next-action', source: 'workflow-next', updatedAt: '2026-11-10T09:59:59Z' },
          ],
        }),
      ],
    })
    expect(result.projects[0]!.sessions[0]!.tasks).toMatchObject([
      {
        key: 'DEV-BETWEEN',
        status: 'covered',
        firstWorkedAt: '2026-11-10T10:00:00Z',
        lastWorkedAt: '2026-11-10T14:00:00Z',
      },
      {
        key: 'DEV-OLDER',
        status: 'uncovered',
        firstWorkedAt: '2026-11-10T10:00:00Z',
        lastWorkedAt: '2026-11-10T14:00:00Z',
      },
    ])
  })

  test('excludes the terminal pseudo-session', () => {
    const result = contextCensus({
      since,
      sessions: [session, { ...session, session: `${OPERATOR_SESSION_PREFIX}machine-id` }],
      work: [work('DEV-1')],
      tasks: [task('DEV-1')],
    })
    expect(
      result.projects.flatMap(({ sessions }) => sessions.map(({ session }) => session)),
    ).toEqual(['architect'])
  })

  test('closed is covered and unreadable is never covered', () => {
    const result = contextCensus({
      since,
      sessions: [session],
      work: [work('DEV-DONE'), work('DEV-BROKEN')],
      tasks: [
        task('DEV-DONE', { statusCategory: 'done' }),
        task('DEV-BROKEN', { statusCategory: 'done', unreadable: 'retry task list' }),
      ],
    })
    expect(result.projects[0]!.sessions[0]!.tasks.map(({ status }) => status)).toEqual([
      'unreadable',
      'covered',
    ])
    expect(result.verdict.unreadable).toEqual([{ task: 'DEV-BROKEN', remedy: 'retry task list' }])
  })

  test('prints a no-holder session and ignores work outside the window', () => {
    const result = contextCensus({
      since,
      sessions: [session],
      work: [work('DEV-OLD', '2026-11-04T23:59:59Z')],
      tasks: [task('DEV-OLD')],
    })
    expect(result.projects[0]!.sessions[0]).toMatchObject({
      covered: 0,
      total: 0,
      noHolder: true,
      tasks: [],
    })
    expect(result.verdict.full).toBe(true)
  })

  test('keeps a task whose only in-window work is its renewal event', () => {
    const result = contextCensus({
      since,
      sessions: [session],
      work: [
        work('DEV-RENEWED', '2026-11-04T23:59:59Z'),
        work('DEV-RENEWED', '2026-11-06T00:00:00Z'),
      ],
      tasks: [task('DEV-RENEWED')],
    })
    expect(result.projects[0]!.sessions[0]!.tasks).toMatchObject([
      { key: 'DEV-RENEWED', status: 'uncovered' },
    ])
    expect(result.verdict.full).toBe(false)
  })

  test('takes projects from key prefixes and partitions a session across them', () => {
    const noPresence = { ...session, project: null }
    const result = contextCensus({
      since,
      sessions: [noPresence],
      work: [work('DEV-1'), work('APP-1', undefined, 'app')],
      tasks: [task('DEV-1'), task('APP-1', { project: 'app' })],
    })
    expect(
      result.projects.map(({ project, sessions }) => [
        project,
        sessions[0]!.tasks.map(({ key }) => key),
      ]),
    ).toEqual([
      ['app', ['APP-1']],
      [PLATFORM_SLUG, ['DEV-1']],
    ])
  })

  test('keeps an unknown task prefix under no project and unreadable', () => {
    const result = contextCensus({
      since,
      sessions: [{ ...session, project: null }],
      work: [work('UNKNOWN-1', undefined, null)],
      tasks: [task('UNKNOWN-1', { project: null, unreadable: 'declare the task prefix' })],
    })
    expect(result.projects[0]).toMatchObject({
      project: null,
      covered: 0,
      total: 1,
      sessions: [{ session: 'architect', covered: 0, total: 1 }],
    })
    expect(result.verdict).toEqual({
      full: false,
      uncovered: [],
      unreadable: [{ task: 'UNKNOWN-1', remedy: 'declare the task prefix' }],
    })
  })

  test('reports counts and classifies item sources', () => {
    const result = contextCensus({
      since,
      sessions: [session],
      work: [work('DEV-1')],
      tasks: [
        task('DEV-1', {
          items: [
            { kind: 'next-action', source: 'pr-merge', updatedAt: '2026-11-11T00:00:00Z' },
            { kind: 'open-question', source: 'q9', updatedAt: '2026-11-11T00:00:00Z' },
            { kind: 'ruling', source: 'chat 2026-11-11', updatedAt: '2026-11-11T00:00:00Z' },
          ],
        }),
      ],
    })
    expect(result.projects[0]!.sessions[0]!.tasks[0]).toMatchObject({
      openQuestions: 1,
      rulings: 1,
      sources: [
        { source: 'pr-merge', writingVerb: true },
        { source: 'q9', writingVerb: true },
        { source: 'chat 2026-11-11', writingVerb: false },
      ],
    })
  })

  test('selects one project and derives its verdict from only those rows', () => {
    const report = contextCensus({
      since,
      sessions: [
        { session: 'architect-a', lastSeen: session.lastSeen, project: 'a' },
        { session: 'architect-b', lastSeen: session.lastSeen, project: 'b' },
      ],
      work: [
        { session: 'architect-a', key: 'A-UNCOVERED', at: '2026-11-10T12:00:00Z', project: 'a' },
        { session: 'architect-a', key: 'A-UNREADABLE', at: '2026-11-10T12:00:00Z', project: 'a' },
        { session: 'architect-b', key: 'B-COVERED', at: '2026-11-10T12:00:00Z', project: 'b' },
      ],
      tasks: [
        task('A-UNCOVERED', { project: 'a' }),
        task('A-UNREADABLE', { project: 'a', unreadable: 'retry project a' }),
        task('B-COVERED', { project: 'b', statusCategory: 'done' }),
      ],
    })

    expect(selectCensusProject(report, 'a')).toMatchObject({
      projects: [{ project: 'a' }],
      verdict: {
        full: false,
        uncovered: ['A-UNCOVERED'],
        unreadable: [{ task: 'A-UNREADABLE', remedy: 'retry project a' }],
      },
    })
    expect(selectCensusProject(report, 'b')).toMatchObject({
      projects: [{ project: 'b' }],
      verdict: { full: true, uncovered: [], unreadable: [] },
    })
    expect(censusVerdict(report.projects)).toEqual(report.verdict)
  })
})
