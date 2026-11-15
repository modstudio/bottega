// concern: session-report
/** Pure session measurement policy over plain lifecycle facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type SessionReportWindow = { since: string; until: string }

export type SessionReportFacts = {
  sessionId: string
  runs: Array<{
    id: string
    job: string
    startedAt: string
    launchKey: string | null
    cursorId: string | null
  }>
  unscoredRuns: Array<{
    id: string
    startedAt: string
    unscoredToday: boolean
    scoredAt: string | null
  }>
  heldTreeRunIds: string[]
  cursors: Array<{
    id: string
    number: number
    workflow: string
    taskKey: string | null
    createdAt: string
    updatedAt: string
    openToday: boolean
  }>
  questions: Array<{
    id: string
    askedAt: string
    answeredAt: string | null
    closedAt: string | null
  }>
}

export type SessionWindowReport = {
  sessionId: string
  window: SessionReportWindow
  runsWithoutCursor: {
    total: number
    keyless: Array<{ job: string; count: number; runIds: string[] }>
    keyedOverridden: Array<{ job: string; count: number; runIds: string[] }>
  }
  residueAtWindowEnd: {
    unscoredRuns: { count: number; runIds: string[] }
    heldTrees: { count: number; runIds: string[]; asOf?: 'now' }
    openCursors: {
      count: number
      cursors: Array<{
        id: string
        number: number
        workflow: string
        taskKey: string | null
        idleMs: number
      }>
    }
    unansweredQuestions: { count: number; questionIds: string[] }
  }
  hookOutput: { recorded: false; message: string }
}

export type SessionReportDelta = {
  runsWithoutCursor: { total: number; keyless: number; keyedOverridden: number }
  residueAtWindowEnd: {
    unscoredRuns: number
    heldTrees: null
    openCursors: number
    unansweredQuestions: number
  }
}

export function reportWindow(
  since: string | undefined,
  until: string | undefined,
  now: string,
): SessionReportWindow {
  const start = since ?? '1970-01-01T00:00:00.000Z'
  const end = until ?? now
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs)) throw new Error(`invalid --since bound: ${start}`)
  if (!Number.isFinite(endMs)) throw new Error(`invalid --until bound: ${end}`)
  if (startMs > endMs)
    throw new Error(
      `reversed session report window: --since ${start} is after --until ${end}; choose bounds in chronological order`,
    )
  return { since: new Date(startMs).toISOString(), until: new Date(endMs).toISOString() }
}

export function comparisonWindow(value: string, now: string): SessionReportWindow {
  const separator = value.indexOf('..')
  if (separator < 1 || separator === value.length - 2)
    throw new Error(`invalid --compare window ${value}; use <since>..<until>`)
  return reportWindow(value.slice(0, separator), value.slice(separator + 2), now)
}

export function selectReportSessions(
  requested: readonly string[],
  all: boolean,
  known: readonly string[],
): string[] {
  if (all === Boolean(requested.length))
    throw new Error('select sessions with either repeatable --session <id> or --all')
  const selected = all ? [...known] : [...new Set(requested)]
  for (const sessionId of selected)
    if (!known.includes(sessionId))
      throw new Error(
        `unknown session ${sessionId}; list recorded sessions with ${PLATFORM_SLUG} session report --all --json`,
      )
  return selected
}

const groupByJob = (rows: SessionReportFacts['runs']) =>
  [...Map.groupBy(rows, (row) => row.job)]
    .map(([job, grouped]) => ({ job, count: grouped.length, runIds: grouped.map((row) => row.id) }))
    .sort((left, right) => left.job.localeCompare(right.job))

export function buildSessionWindowReport(
  facts: SessionReportFacts,
  window: SessionReportWindow,
  generatedAt: string,
): SessionWindowReport {
  const since = Date.parse(window.since)
  const until = Date.parse(window.until)
  const withoutCursor = facts.runs.filter((run) => {
    const started = Date.parse(run.startedAt)
    return started >= since && started <= until && run.cursorId === null
  })
  const keyless = withoutCursor.filter((run) => run.launchKey === null)
  const keyed = withoutCursor.filter((run) => run.launchKey !== null)
  const unscoredRunIds = facts.unscoredRuns
    .filter(
      (run) =>
        Date.parse(run.startedAt) <= until &&
        (run.unscoredToday || Date.parse(run.scoredAt ?? '') > until),
    )
    .map((run) => run.id)
  const questionIds = facts.questions
    .filter(
      (question) =>
        Date.parse(question.askedAt) <= until &&
        ((question.answeredAt === null && question.closedAt === null) ||
          Date.parse(question.answeredAt ?? question.closedAt ?? '') > until),
    )
    .map((question) => question.id)
  const cursors = facts.cursors
    .filter(
      (cursor) =>
        Date.parse(cursor.createdAt) <= until &&
        (cursor.openToday || Date.parse(cursor.updatedAt) > until),
    )
    .map((cursor) => {
      const updatedAt = Date.parse(cursor.updatedAt)
      const idleSince = updatedAt <= until ? updatedAt : Date.parse(cursor.createdAt)
      return {
        id: cursor.id,
        number: cursor.number,
        workflow: cursor.workflow,
        taskKey: cursor.taskKey,
        idleMs: Math.max(0, until - idleSince),
      }
    })
    .filter((cursor) => Number.isFinite(cursor.idleMs))
  const heldTrees = {
    count: facts.heldTreeRunIds.length,
    runIds: facts.heldTreeRunIds,
    ...(until < Date.parse(generatedAt) ? ({ asOf: 'now' } as const) : {}),
  }
  return {
    sessionId: facts.sessionId,
    window,
    runsWithoutCursor: {
      total: withoutCursor.length,
      keyless: groupByJob(keyless),
      keyedOverridden: groupByJob(keyed),
    },
    residueAtWindowEnd: {
      unscoredRuns: { count: unscoredRunIds.length, runIds: unscoredRunIds },
      heldTrees,
      openCursors: { count: cursors.length, cursors },
      unansweredQuestions: {
        count: questionIds.length,
        questionIds,
      },
    },
    hookOutput: { recorded: false, message: 'no hook emissions are recorded yet' },
  }
}

const categoryCount = (groups: SessionWindowReport['runsWithoutCursor']['keyless']) =>
  groups.reduce((sum, group) => sum + group.count, 0)

export function sessionReportDelta(
  current: SessionWindowReport,
  comparison: SessionWindowReport,
): SessionReportDelta {
  return {
    runsWithoutCursor: {
      total: current.runsWithoutCursor.total - comparison.runsWithoutCursor.total,
      keyless:
        categoryCount(current.runsWithoutCursor.keyless) -
        categoryCount(comparison.runsWithoutCursor.keyless),
      keyedOverridden:
        categoryCount(current.runsWithoutCursor.keyedOverridden) -
        categoryCount(comparison.runsWithoutCursor.keyedOverridden),
    },
    residueAtWindowEnd: {
      unscoredRuns:
        current.residueAtWindowEnd.unscoredRuns.count -
        comparison.residueAtWindowEnd.unscoredRuns.count,
      heldTrees: null,
      openCursors:
        current.residueAtWindowEnd.openCursors.count -
        comparison.residueAtWindowEnd.openCursors.count,
      unansweredQuestions:
        current.residueAtWindowEnd.unansweredQuestions.count -
        comparison.residueAtWindowEnd.unansweredQuestions.count,
    },
  }
}
