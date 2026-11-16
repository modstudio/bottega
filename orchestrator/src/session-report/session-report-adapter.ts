// concern: session-report
/** Gathers session report facts from the canonical lifecycle queries. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { UNSCORED_WHERE } from '../evidence/evidence-query.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  buildSessionWindowReport,
  comparisonWindow,
  reportWindow,
  type SessionReportFacts,
  selectReportSessions,
  sessionReportDelta,
} from './session-report.ts'

type RunRow = {
  record_id: string
  job: string
  started_at: string
  launch_key: string | null
  cursor_record_id: string | null
}

type CursorRow = {
  record_id: string
  number: number
  workflow_slug: string
  workflow_key: string
  created_at: string
  updated_at: string
}

export type SessionReport = {
  generatedAt: string
  sessions: Array<{
    sessionId: string
    current: ReturnType<typeof buildSessionWindowReport>
    comparison: ReturnType<typeof buildSessionWindowReport> | null
    delta: ReturnType<typeof sessionReportDelta> | null
  }>
}

function knownSessions(database: Database): string[] {
  return database
    .query<{ session_id: string }, []>(
      `SELECT session_id FROM session_seen
       UNION SELECT session_id FROM run WHERE session_id IS NOT NULL
       UNION SELECT session_id FROM workflow_cursor WHERE session_id IS NOT NULL
       UNION SELECT session_id FROM hook_emission
       ORDER BY session_id`,
    )
    .all()
    .map((row) => row.session_id)
}

async function factsForSession(
  database: Database,
  sessionId: string,
  end: string,
): Promise<SessionReportFacts> {
  const runs = database
    .query<RunRow, [string, string]>(
      `SELECT record_id,job,started_at,launch_key,cursor_record_id FROM run
       WHERE session_id=? AND started_at<=? ORDER BY number`,
    )
    .all(sessionId, end)
    .map((row) => ({
      id: row.record_id,
      job: row.job,
      startedAt: row.started_at,
      launchKey: row.launch_key,
      cursorId: row.cursor_record_id,
    }))
  const unscoredRuns = database
    .query<
      {
        record_id: string
        started_at: string
        scored_at: string | null
        unscored_today: number
      },
      [string, string]
    >(
      `SELECT r.record_id,r.started_at,s.scored_at,(${UNSCORED_WHERE}) unscored_today
       FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
       WHERE r.session_id=? AND r.started_at<=?
       ORDER BY r.number`,
    )
    .all(sessionId, end)
    .map((row) => ({
      id: row.record_id,
      startedAt: row.started_at,
      unscoredToday: Boolean(row.unscored_today),
      scoredAt: row.scored_at,
    }))
  const heldTreeRunIds = database
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM run
       WHERE session_id=? AND parent_run_record_id IS NULL AND close_out_outcome='held'
       ORDER BY number`,
    )
    .all(sessionId)
    .map((row) => row.record_id)
  const openCursorIds = new Set(
    (await taskFlowReadStore(database).openStagesForSession(sessionId)).map((row) => row.record_id),
  )
  const cursors = database
    .query<CursorRow, [string, string]>(
      `SELECT record_id,number,workflow_slug,workflow_key,created_at,updated_at
       FROM workflow_cursor
       WHERE session_id=? AND created_at<=?
       ORDER BY number`,
    )
    .all(sessionId, end)
    .map((row) => ({
      id: row.record_id,
      number: row.number,
      workflow: row.workflow_slug,
      taskKey: row.workflow_key || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      openToday: openCursorIds.has(row.record_id),
    }))
  const questions = database
    .query<
      {
        record_id: string
        asked_at: string
        answered_at: string | null
        closed_at: string | null
      },
      [string, string]
    >(
      `SELECT q.record_id,q.asked_at,q.answered_at,q.closed_at FROM question q
       LEFT JOIN run r ON r.record_id=q.run_record_id
       LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
       WHERE COALESCE(r.session_id,c.session_id)=? AND q.asked_at<=?
       ORDER BY q.asked_at,q.number`,
    )
    .all(sessionId, end)
    .map((row) => ({
      id: row.record_id,
      askedAt: row.asked_at,
      answeredAt: row.answered_at,
      closedAt: row.closed_at,
    }))
  const hookEmissions = database
    .query<
      { at: string; event: string; kind: string; chars: number; text_hash: string },
      [string, string]
    >(
      `SELECT at,event,kind,chars,text_hash FROM hook_emission WHERE session_id=? AND at<=? ORDER BY at,record_id`,
    )
    .all(sessionId, end)
    .map((row) => ({
      at: row.at,
      event: row.event,
      kind: row.kind,
      chars: row.chars,
      textHash: row.text_hash,
    }))
  return { sessionId, runs, unscoredRuns, heldTreeRunIds, cursors, questions, hookEmissions }
}

export async function sessionReport(
  input: { sessions: string[]; all: boolean; since?: string; until?: string; compare?: string },
  dependencies: { database?: Database; now?: () => string } = {},
): Promise<SessionReport> {
  const database = dependencies.database ?? db()
  const generatedAt = (dependencies.now ?? (() => new Date().toISOString()))()
  const currentWindow = reportWindow(input.since, input.until, generatedAt)
  const compareWindow = input.compare ? comparisonWindow(input.compare, generatedAt) : null
  const known = knownSessions(database)
  const selected = selectReportSessions(input.sessions, input.all, known)
  return {
    generatedAt,
    sessions: await Promise.all(
      selected.map(async (sessionId) => {
        const current = buildSessionWindowReport(
          await factsForSession(database, sessionId, currentWindow.until),
          currentWindow,
          generatedAt,
        )
        const comparison = compareWindow
          ? buildSessionWindowReport(
              await factsForSession(database, sessionId, compareWindow.until),
              compareWindow,
              generatedAt,
            )
          : null
        return {
          sessionId,
          current,
          comparison,
          delta: comparison ? sessionReportDelta(current, comparison) : null,
        }
      }),
    ),
  }
}
