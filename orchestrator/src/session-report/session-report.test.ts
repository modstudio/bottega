// concern: session-report

import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  buildSessionWindowReport,
  comparisonWindow,
  reportWindow,
  type SessionReportFacts,
  selectReportSessions,
  sessionReportDelta,
} from './session-report.ts'
import { formatSessionReport } from './session-report-format.ts'

const window = { since: '2026-11-15T12:00:00.000Z', until: '2026-11-15T13:00:00.000Z' }
const facts = (runs: SessionReportFacts['runs']): SessionReportFacts => ({
  sessionId: 'session-a',
  runs,
  unscoredRuns: [],
  heldTreeRunIds: [],
  cursors: [],
  questions: [],
})

describe('session report policy', () => {
  test('reports keyless runs in the window and excludes cursor-bound runs', () => {
    const report = buildSessionWindowReport(
      facts([
        {
          id: 'keyless',
          job: 'implement',
          startedAt: '2026-11-15T12:30:00Z',
          launchKey: null,
          cursorId: null,
        },
        {
          id: 'bound',
          job: 'implement',
          startedAt: '2026-11-15T12:31:00Z',
          launchKey: 'DEV-1',
          cursorId: 'cursor-1',
        },
        {
          id: 'earlier',
          job: 'review',
          startedAt: '2026-11-15T11:59:00Z',
          launchKey: null,
          cursorId: null,
        },
      ]),
      window,
      window.until,
    )
    expect(report.runsWithoutCursor).toEqual({
      total: 1,
      keyless: [{ job: 'implement', count: 1, runIds: ['keyless'] }],
      keyedOverridden: [],
    })
  })

  test('reports keyed overrides separately from keyless runs', () => {
    const report = buildSessionWindowReport(
      facts([
        {
          id: 'overridden',
          job: 'implement',
          startedAt: '2026-11-15T12:30:00Z',
          launchKey: 'DEV-1',
          cursorId: null,
        },
      ]),
      window,
      window.until,
    )

    expect(report.runsWithoutCursor).toEqual({
      total: 1,
      keyless: [],
      keyedOverridden: [{ job: 'implement', count: 1, runIds: ['overridden'] }],
    })
  })

  test('refuses a reversed window and names both bounds', () => {
    expect(() =>
      reportWindow('2026-11-15T13:00:00Z', '2026-11-15T12:00:00Z', '2026-11-15T14:00:00Z'),
    ).toThrow('2026-11-15T13:00:00Z is after --until 2026-11-15T12:00:00Z')
  })

  test('refuses an unknown session and names the listing remedy', () => {
    expect(() => selectReportSessions(['missing'], false, ['known'])).toThrow(
      `unknown session missing; list recorded sessions with ${PLATFORM_SLUG} session report --all --json`,
    )
  })

  test('builds a comparison window and deltas every count', () => {
    const current = buildSessionWindowReport(
      facts([
        {
          id: 'one',
          job: 'implement',
          startedAt: '2026-11-15T12:30:00Z',
          launchKey: null,
          cursorId: null,
        },
      ]),
      window,
      window.until,
    )
    const prior = buildSessionWindowReport(
      facts([]),
      comparisonWindow('2026-11-15T10:00:00Z..2026-11-15T11:00:00Z', window.until),
      window.until,
    )
    const delta = sessionReportDelta(current, prior)
    expect(delta).toEqual({
      runsWithoutCursor: { total: 1, keyless: 1, keyedOverridden: 0 },
      residueAtWindowEnd: {
        unscoredRuns: 0,
        heldTrees: null,
        openCursors: 0,
        unansweredQuestions: 0,
      },
    })
    const rendered = formatSessionReport({
      generatedAt: window.until,
      sessions: [{ sessionId: 'session-a', current, comparison: prior, delta }],
    })
    expect(rendered).toContain(
      'comparison window: 2026-11-15T10:00:00.000Z to 2026-11-15T11:00:00.000Z',
    )
    expect(rendered).toContain('delta (current - comparison):')
    expect(rendered).toContain('held trees: n/a')
  })

  test('reconstructs run, question, and cursor residue at each window end', () => {
    const lifecycleFacts: SessionReportFacts = {
      ...facts([]),
      unscoredRuns: [
        {
          id: 'still-unscored',
          startedAt: '2026-11-15T11:00:00.000Z',
          unscoredToday: true,
          scoredAt: null,
        },
        {
          id: 'scored-later',
          startedAt: '2026-11-15T11:00:00.000Z',
          unscoredToday: false,
          scoredAt: '2026-11-15T12:30:00.000Z',
        },
      ],
      questions: [
        {
          id: 'answered-later',
          askedAt: '2026-11-15T11:00:00.000Z',
          answeredAt: '2026-11-15T12:30:00.000Z',
          closedAt: null,
        },
      ],
      cursors: [
        {
          id: 'cursor-later',
          number: 42,
          workflow: 'ship-task',
          taskKey: 'DEV-1',
          createdAt: '2026-11-15T11:00:00.000Z',
          updatedAt: '2026-11-15T12:30:00.000Z',
          openToday: false,
        },
      ],
    }
    const beforeClosures = buildSessionWindowReport(
      lifecycleFacts,
      { since: window.since, until: '2026-11-15T12:00:00.000Z' },
      window.until,
    )
    const afterClosures = buildSessionWindowReport(lifecycleFacts, window, window.until)

    expect(beforeClosures.residueAtWindowEnd).toMatchObject({
      unscoredRuns: {
        count: 2,
        runIds: ['still-unscored', 'scored-later'],
        asOf: 'approximate',
      },
      unansweredQuestions: { count: 1 },
      openCursors: {
        count: 1,
        asOf: 'approximate',
        cursors: [{ id: 'cursor-later', idleMs: 60 * 60_000 }],
      },
    })
    expect(afterClosures.residueAtWindowEnd).toMatchObject({
      unscoredRuns: { count: 1, runIds: ['still-unscored'] },
      unansweredQuestions: { count: 0 },
      openCursors: { count: 0 },
    })
    expect(afterClosures.residueAtWindowEnd.unscoredRuns).not.toHaveProperty('asOf')
    expect(afterClosures.residueAtWindowEnd.openCursors).not.toHaveProperty('asOf')
  })

  test('marks historical held-tree state and keeps identifiers out of human output', () => {
    const report = buildSessionWindowReport(
      {
        ...facts([
          {
            id: 'run-secret',
            job: 'implement',
            startedAt: '2026-11-15T12:30:00Z',
            launchKey: null,
            cursorId: null,
          },
        ]),
        heldTreeRunIds: ['held-secret'],
        cursors: [
          {
            id: 'cursor-secret',
            number: 42,
            workflow: 'ship-task',
            taskKey: 'DEV-1',
            createdAt: '2026-11-15T10:00:00Z',
            updatedAt: '2026-11-15T11:06:00Z',
            openToday: true,
          },
        ],
      },
      window,
      '2026-11-15T14:00:00.000Z',
    )
    const rendered = formatSessionReport({
      generatedAt: '2026-11-15T14:00:00.000Z',
      sessions: [{ sessionId: 'session-a', current: report, comparison: null, delta: null }],
    })

    expect(report.residueAtWindowEnd.heldTrees).toEqual({
      count: 1,
      runIds: ['held-secret'],
      asOf: 'now',
    })
    expect(rendered).toContain('held trees (current): 1')
    expect(rendered).toContain('unscored runs (approximate): 0')
    expect(rendered).toContain('open cursors (approximate): 1')
    expect(rendered).toContain('42 ship-task DEV-1: idle 1h 54m')
    expect(rendered).toContain('implement: 1')
    expect(rendered).not.toContain('run-secret')
    expect(rendered).not.toContain('held-secret')
    expect(rendered).not.toContain('cursor-secret')
  })
})
