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
  hookEmissions: Array<{ at: string; event: string; kind: string; chars: number; textHash: string }>
}

export type SessionWindowReport = {
  sessionId: string
  window: SessionReportWindow
  runsWithoutCursor: {
    total: number
    keyless: Array<{ job: string; count: number; runIds: string[] }>
    keyedUncovered: Array<{ job: string; count: number; runIds: string[] }>
    admitted: {
      count: number
      byJob: Array<{ job: string; count: number; runIds: string[] }>
      asOf?: 'approximate'
    }
  }
  residueAtWindowEnd: {
    unscoredRuns: { count: number; runIds: string[]; asOf?: 'approximate' }
    heldTrees: { count: number; runIds: string[]; asOf?: 'now' }
    openCursors: {
      count: number
      asOf?: 'approximate'
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
  hookOutput: Array<{
    event: string
    kind: string
    count: number
    characters: number
    meanSize: number
    repeatedShare: number
  }>
}

export type SessionReportDelta = {
  runsWithoutCursor: { total: number; keyless: number; keyedUncovered: number; admitted: number }
  residueAtWindowEnd: {
    unscoredRuns: number
    heldTrees: null
    openCursors: number
    unansweredQuestions: number
  }
  hookOutput: { count: number; characters: number }
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

const admittedByTaskCursor = (
  run: SessionReportFacts['runs'][number],
  cursors: SessionReportFacts['cursors'],
) =>
  run.launchKey !== null &&
  cursors.some(
    (cursor) =>
      cursor.taskKey === run.launchKey &&
      Date.parse(cursor.createdAt) <= Date.parse(run.startedAt) &&
      (cursor.openToday || Date.parse(cursor.updatedAt) >= Date.parse(run.startedAt)),
  )

export function buildSessionWindowReport(
  facts: SessionReportFacts,
  window: SessionReportWindow,
  generatedAt: string,
): SessionWindowReport {
  const since = Date.parse(window.since)
  const until = Date.parse(window.until)
  const runsInWindow = facts.runs.filter((run) => {
    const started = Date.parse(run.startedAt)
    return started >= since && started <= until
  })
  const unbound = runsInWindow.filter((run) => run.cursorId === null)
  const keyless = unbound.filter((run) => run.launchKey === null)
  const admitted = unbound.filter((run) => admittedByTaskCursor(run, facts.cursors))
  const admittedIds = new Set(admitted.map((run) => run.id))
  const keyedUncovered = unbound.filter((run) => run.launchKey !== null && !admittedIds.has(run.id))
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
  const historical = until < Date.parse(generatedAt)
  const seenHookHashes = new Map<string, Set<string>>()
  const emissionsInWindow = [...facts.hookEmissions]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .flatMap((row) => {
      const key = `${row.event}\0${row.kind}`
      const seen = seenHookHashes.get(key) ?? new Set<string>()
      const repeated = seen.has(row.textHash)
      seen.add(row.textHash)
      seenHookHashes.set(key, seen)
      const at = Date.parse(row.at)
      return at >= since && at <= until ? [{ ...row, repeated }] : []
    })
  const hookOutput = [...Map.groupBy(emissionsInWindow, (row) => `${row.event}\0${row.kind}`)]
    .map(([key, rows]) => {
      const [event, kind] = key.split('\0')
      const repeated = rows.filter((row) => row.repeated).length
      const characters = rows.reduce((sum, row) => sum + row.chars, 0)
      return {
        event,
        kind,
        count: rows.length,
        characters,
        meanSize: characters / rows.length,
        repeatedShare: repeated / rows.length,
      }
    })
    .sort(
      (left, right) => left.event.localeCompare(right.event) || left.kind.localeCompare(right.kind),
    )
  return {
    sessionId: facts.sessionId,
    window,
    runsWithoutCursor: {
      total: keyless.length + keyedUncovered.length,
      keyless: groupByJob(keyless),
      keyedUncovered: groupByJob(keyedUncovered),
      admitted: {
        count: admitted.length,
        byJob: groupByJob(admitted),
        ...(historical ? ({ asOf: 'approximate' } as const) : {}),
      },
    },
    residueAtWindowEnd: {
      unscoredRuns: {
        count: unscoredRunIds.length,
        runIds: unscoredRunIds,
        ...(historical ? ({ asOf: 'approximate' } as const) : {}),
      },
      heldTrees,
      openCursors: {
        count: cursors.length,
        cursors,
        ...(historical ? ({ asOf: 'approximate' } as const) : {}),
      },
      unansweredQuestions: {
        count: questionIds.length,
        questionIds,
      },
    },
    hookOutput,
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
      keyedUncovered:
        categoryCount(current.runsWithoutCursor.keyedUncovered) -
        categoryCount(comparison.runsWithoutCursor.keyedUncovered),
      admitted:
        current.runsWithoutCursor.admitted.count - comparison.runsWithoutCursor.admitted.count,
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
    hookOutput: {
      count:
        current.hookOutput.reduce((sum, row) => sum + row.count, 0) -
        comparison.hookOutput.reduce((sum, row) => sum + row.count, 0),
      characters:
        current.hookOutput.reduce((sum, row) => sum + row.characters, 0) -
        comparison.hookOutput.reduce((sum, row) => sum + row.characters, 0),
    },
  }
}
