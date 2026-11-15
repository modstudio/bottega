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
  unscoredRunIds: [],
  heldTreeRunIds: [],
  openCursors: [],
  unansweredQuestionIds: [],
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
    )
    expect(report.runsWithoutCursor).toEqual({
      total: 1,
      keyless: [{ job: 'implement', count: 1, runIds: ['keyless'] }],
      keyedOverridden: [],
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
    )
    const prior = buildSessionWindowReport(
      facts([]),
      comparisonWindow('2026-11-15T10:00:00Z..2026-11-15T11:00:00Z'),
    )
    const delta = sessionReportDelta(current, prior)
    expect(delta).toEqual({
      runsWithoutCursor: { total: 1, keyless: 1, keyedOverridden: 0 },
      residueAtWindowEnd: { unscoredRuns: 0, heldTrees: 0, openCursors: 0, unansweredQuestions: 0 },
    })
    const rendered = formatSessionReport({
      generatedAt: window.until,
      sessions: [{ sessionId: 'session-a', current, comparison: prior, delta }],
    })
    expect(rendered).toContain(
      'comparison window: 2026-11-15T10:00:00.000Z to 2026-11-15T11:00:00.000Z',
    )
    expect(rendered).toContain('delta (current - comparison):')
  })
})
