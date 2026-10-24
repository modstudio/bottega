// concern: close-out in-flight annotation
/** Gathers cursor and open-PR facts so a held close-out report can carry in-flight landing. */

import { existsSync } from 'node:fs'
import { db } from '../database/db.ts'
import { heldTreeInFlight } from '../landing-tree/landing-tree.ts'
import { annotateHeldTreeDetail, type CloseOutReportResult } from './close-out-report.ts'

const OPEN_PR_TIMEOUT_MS = 3000

type RunLandingFacts = {
  repo: string | null
  branch: string | null
  sessionId: string | null
}

type CursorRow = {
  id: number
  step_slug: string
  workflow_slug: string
  project: string
  args: string
}

function lookupRun(runId: string): RunLandingFacts | null {
  const row = db()
    .query('SELECT repo, branch, session_id FROM run WHERE record_id=?')
    .get(runId) as {
    repo: string | null
    branch: string | null
    session_id: string | null
  } | null
  if (!row) return null
  return { repo: row.repo, branch: row.branch, sessionId: row.session_id }
}

function cursorArg(args: string, key: 'branch' | 'worktree'): string | null {
  try {
    const value = JSON.parse(args) as Record<string, unknown>
    return typeof value[key] === 'string' ? value[key] : null
  } catch {
    return null
  }
}

function lookupShipTaskCursor(
  sessionId: string,
  project: string,
  branch: string,
  treePath: string,
): CursorRow | null {
  const rows = db()
    .query(
      `SELECT number id, step_slug, workflow_slug, project, args
         FROM workflow_cursor
        WHERE session_id = ?
          AND project = ?
          AND workflow_slug = 'ship-task'
          AND state IN ('running','awaiting-ruling')
          AND json_extract(args, '$.branch') = ?
        ORDER BY number`,
    )
    .all(sessionId, project, branch) as CursorRow[]
  return rows.find((row) => cursorArg(row.args, 'worktree') === treePath) ?? rows[0] ?? null
}

function parseOpenPrNumber(stdout: string): string | null {
  const rows = JSON.parse(stdout || '[]') as unknown
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') return null
  const number = (rows[0] as { number?: unknown }).number
  if (typeof number !== 'number' || number <= 0) return null
  return `#${number}`
}

export function lookupOpenPr(
  cwd: string,
  branch: string,
  timeoutMs = OPEN_PR_TIMEOUT_MS,
): string | null {
  if (!branch || !cwd || !existsSync(cwd) || timeoutMs <= 0) return null
  try {
    const result = Bun.spawnSync(
      ['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'],
      { cwd, stdout: 'pipe', stderr: 'pipe', timeout: Math.min(OPEN_PR_TIMEOUT_MS, timeoutMs) },
    )
    return result.exitCode === 0 ? parseOpenPrNumber(result.stdout.toString()) : null
  } catch {
    return null
  }
}

function cursorFacts(row: CursorRow | null) {
  if (!row) return null
  return {
    id: row.id,
    workflow: row.workflow_slug,
    step: row.step_slug,
    live: true,
    project: row.project,
    branch: cursorArg(row.args, 'branch'),
    worktree: cursorArg(row.args, 'worktree'),
  }
}

function lookupCursor(run: RunLandingFacts, treePath: string): CursorRow | null {
  if (!run.sessionId || !run.repo || !run.branch) return null
  return lookupShipTaskCursor(run.sessionId, run.repo, run.branch, treePath)
}

function inFlightForHold(worktree: string, run: RunLandingFacts, uniqueWork: boolean) {
  const fromCursor = heldTreeInFlight({
    treePath: worktree,
    project: run.repo,
    branch: run.branch,
    cursor: cursorFacts(lookupCursor(run, worktree)),
    openPr: null,
    uniqueWork,
  })
  if (fromCursor) return fromCursor
  return heldTreeInFlight({
    treePath: worktree,
    project: run.repo,
    branch: run.branch,
    cursor: null,
    openPr: run.branch ? lookupOpenPr(worktree, run.branch) : null,
    uniqueWork,
  })
}

export function annotateHeldLandingInFlight(result: CloseOutReportResult): CloseOutReportResult {
  if ((result.reportOutcome ?? result.outcome) !== 'held' || !result.worktree) return result
  const run = lookupRun(result.runId)
  if (!run) return result
  const inFlight = inFlightForHold(result.worktree, run, result.hold !== 'landing-progress')
  return {
    ...result,
    detail: annotateHeldTreeDetail(result.detail, inFlight),
    inFlightRef: inFlight?.ref ?? null,
    suppressBlock: inFlight?.suppressBlock ?? false,
  }
}
