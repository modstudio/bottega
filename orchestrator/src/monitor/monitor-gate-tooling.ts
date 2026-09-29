// concern: monitor-gate-tooling
/** Owns worker gate tooling-change condition decisions and their database and Git observations. */

import type { Database } from 'bun:sqlite'
import { offlineBranchLandingObservations } from '../branch/offline-branch-landing.ts'
import { db } from '../database/db.ts'
import type { MonitorCondition } from './monitor-types.ts'

type WorkerGateToolingFacts = {
  runId: number
  startedAt: string
  ownerSession: string | null
  executions: { paths: string[]; command: string }[]
  admitted: boolean
  landed: boolean
  branchExists: boolean
}

type AdapterFacts = WorkerGateToolingFacts & {
  projectId: number | null
  project: string | null
  branch: string | null
}

type ToolingRow = {
  run_id: number
  tooling_paths: string
  resolved_command: string | null
  started_at: string
  session_id: string | null
  project_id: number | null
  project_name: string | null
  branch: string | null
  admitted: number
}

export function workerGateToolingCondition(facts: WorkerGateToolingFacts): MonitorCondition | null {
  const affected = facts.executions.filter((execution) => execution.paths.length)
  if (!affected.length || facts.admitted || facts.landed || !facts.branchExists) return null
  const detail = affected
    .map(
      (execution) =>
        `paths ${execution.paths.join(', ')}; command ${execution.command || '(not recorded)'}`,
    )
    .join(' | ')
  return {
    kind: 'worker-gate-tooling-change',
    subject: `run:${facts.runId}`,
    since: facts.startedAt,
    ageMs: null,
    detail: `worker gate executed with changed tooling: ${detail}`,
    action: 'review those tooling changes before landing',
    ownerSession: facts.ownerSession,
  }
}

function toolingRows(database: Database): ToolingRow[] {
  return database
    .query(
      `WITH latest_tooling AS (
         SELECT run_id,MAX(id) gate_id
           FROM gate_execution
          WHERE run_id IS NOT NULL AND tooling_paths <> '[]'
          GROUP BY run_id
       )
       SELECT g.run_id,g.tooling_paths,g.resolved_command,r.started_at,r.session_id,
              p.id project_id,p.name project_name,COALESCE(r.minted_branch,r.branch) branch,
              CASE WHEN latest_gate.finished_at IS NOT NULL AND EXISTS (
                SELECT 1 FROM landing_triage_snapshot snapshot
                 WHERE snapshot.project=p.name
                   AND snapshot.branch=COALESCE(r.minted_branch,r.branch)
                   AND snapshot.at>=latest_gate.finished_at
              ) THEN 1 ELSE 0 END admitted
       FROM gate_execution g
       JOIN latest_tooling latest ON latest.run_id=g.run_id
       JOIN gate_execution latest_gate ON latest_gate.id=latest.gate_id
       JOIN run r ON r.id=g.run_id
       LEFT JOIN project p ON p.id=COALESCE(
         r.project_id,
         (SELECT legacy.id FROM project legacy WHERE legacy.name=r.repo LIMIT 1)
       )
       WHERE g.run_id IS NOT NULL AND g.tooling_paths <> '[]' ORDER BY g.run_id,g.id`,
    )
    .all() as ToolingRow[]
}

function factsByRun(rows: readonly ToolingRow[]): Map<number, AdapterFacts> {
  const byRun = new Map<number, AdapterFacts>()
  for (const row of rows) {
    const facts = byRun.get(row.run_id) ?? {
      runId: row.run_id,
      startedAt: row.started_at,
      ownerSession: row.session_id,
      executions: [],
      admitted: row.admitted === 1,
      landed: false,
      branchExists: true,
      projectId: row.project_id,
      project: row.project_name,
      branch: row.branch,
    }
    const parsed = JSON.parse(row.tooling_paths) as unknown
    facts.executions.push({
      paths: Array.isArray(parsed)
        ? parsed.filter((path): path is string => typeof path === 'string')
        : [],
      command: row.resolved_command ?? '',
    })
    byRun.set(row.run_id, facts)
  }
  return byRun
}

function unresolvedFacts(byRun: ReadonlyMap<number, AdapterFacts>): AdapterFacts[] {
  return [...byRun.values()].filter(
    (facts) =>
      !facts.admitted &&
      facts.projectId !== null &&
      facts.project !== null &&
      facts.branch !== null,
  )
}

function addBranchObservations(facts: readonly AdapterFacts[], database: Database): void {
  const candidates = [
    ...new Map(
      facts.map((item) => [
        `${item.projectId}\0${item.branch}`,
        { projectId: item.projectId!, project: item.project!, branch: item.branch! },
      ]),
    ).values(),
  ]
  const observations = new Map(
    offlineBranchLandingObservations(candidates, database).map((observation) => [
      `${observation.projectId}\0${observation.branch}`,
      observation,
    ]),
  )
  for (const item of facts) {
    const observation = observations.get(`${item.projectId}\0${item.branch}`)
    if (!observation) continue
    item.landed = observation.landed
    item.branchExists = observation.branchExists
  }
}

export function workerGateToolingConditions(database = db()): MonitorCondition[] {
  const byRun = factsByRun(toolingRows(database))
  addBranchObservations(unresolvedFacts(byRun), database)
  return [...byRun.values()].flatMap((facts) => {
    const condition = workerGateToolingCondition(facts)
    return condition ? [condition] : []
  })
}
