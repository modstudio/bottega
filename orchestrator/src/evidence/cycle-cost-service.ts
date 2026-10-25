// concern: cycle-cost evidence adapter
/** Reads local landing, run, review, and CI evidence for the pure cycle-cost derivation. */

import type { Database } from 'bun:sqlite'
import { decideLandingTaskKey } from '../branch/branch-landing-service.ts'
import { type Project, projects } from '../project/projects.ts'
import { eligibleReviewRoundRows } from '../review/review-round-budget.ts'
import { reviewRoundIdentity } from '../review/review-round-identity.ts'
import type { ReviewRoundEvidenceRow } from '../review/review-yield.ts'
import {
  type CycleCostCiRecord,
  type CycleCostLanding,
  type CycleCostReport,
  type CycleCostRun,
  type CycleCostUnattributedLanding,
  type CycleCostWindow,
  deriveCycleCost,
} from './cycle-cost.ts'

type LandingRow = {
  project: string
  project_record_id: string | null
  branch: string
  pr_number: number
  merged_at: string
}

type RunRow = {
  project_record_id: string
  launch_key: string | null
  branch: string | null
  job: string
  turn: number
  started_at: string
}

function attributedLandings(
  rows: readonly LandingRow[],
  runs: readonly RunRow[],
  projectsById: ReadonlyMap<string, Project>,
): { landings: CycleCostLanding[]; unattributedLandings: CycleCostUnattributedLanding[] } {
  const landings: CycleCostLanding[] = []
  const unattributedLandings: CycleCostUnattributedLanding[] = []
  for (const landing of rows) {
    if (landing.project_record_id === null) {
      unattributedLandings.push({
        project: landing.project,
        branch: landing.branch,
        pullRequestNumber: landing.pr_number,
        mergedAt: landing.merged_at,
        reason: 'missing project identity',
      })
      continue
    }
    const project = projectsById.get(landing.project_record_id)
    if (!project) {
      unattributedLandings.push({
        project: landing.project,
        branch: landing.branch,
        pullRequestNumber: landing.pr_number,
        mergedAt: landing.merged_at,
        reason: 'project not registered',
      })
      continue
    }
    const decision = decideLandingTaskKey(
      runs.flatMap((run) =>
        run.project_record_id === landing.project_record_id &&
        run.launch_key &&
        run.branch === landing.branch
          ? [run.launch_key]
          : [],
      ),
      landing.branch,
      project.settings.keyPrefixes ?? [],
    )
    if (!decision.attributed) {
      unattributedLandings.push({
        project: project.name,
        branch: landing.branch,
        pullRequestNumber: landing.pr_number,
        mergedAt: landing.merged_at,
        reason: `could not establish one task key; found ${decision.keys.join(', ') || 'none'}`,
      })
      continue
    }
    landings.push({
      project: project.name,
      taskKey: decision.taskKey,
      branch: landing.branch,
      pullRequestNumber: landing.pr_number,
      mergedAt: landing.merged_at,
    })
  }
  return { landings, unattributedLandings }
}

export function loadCycleCostReport(
  database: Database,
  windows: {
    currentWindow: CycleCostWindow
    previousWindow: CycleCostWindow
    project?: string
  },
): CycleCostReport {
  const registeredProjects = [
    ...projects(undefined, database),
    ...projects({ retired: true }, database),
  ]
  const projectsById = new Map(registeredProjects.map((project) => [project.recordId, project]))
  const landingRows = database
    .query(
      `SELECT project,project_record_id,branch,pr_number,merged_at
         FROM branch_landing_record`,
    )
    .all() as LandingRow[]
  const runRows = database
    .query(
      `SELECT project_record_id,launch_key,branch,job,turn,started_at
         FROM run WHERE launch_key IS NOT NULL AND project_record_id IS NOT NULL`,
    )
    .all() as RunRow[]
  const { landings, unattributedLandings } = attributedLandings(landingRows, runRows, projectsById)
  const runs: CycleCostRun[] = runRows.flatMap((row) =>
    row.launch_key && projectsById.has(row.project_record_id)
      ? [
          {
            project: projectsById.get(row.project_record_id)!.name,
            taskKey: row.launch_key,
            job: row.job,
            turn: row.turn,
            startedAt: row.started_at,
          },
        ]
      : [],
  )
  const reviewRounds = eligibleReviewRoundRows(database).flatMap((row: ReviewRoundEvidenceRow) => {
    const round = reviewRoundIdentity(row)
    const project = row.project ?? row.run_repo
    return project && row.branch && round.task && round.identity
      ? [
          {
            project,
            taskKey: round.task,
            branch: row.branch,
            identity: round.identity,
          },
        ]
      : []
  })
  const ciRecords = database
    .query(
      `SELECT project_record_id,pr_number,record_kind,complete,workflow_run_id,
              run_attempt,head_commit,conclusion FROM pull_request_ci`,
    )
    .all() as {
    project_record_id: string
    pr_number: number
    record_kind: 'collection' | 'attempt'
    complete: number | null
    workflow_run_id: string | null
    run_attempt: number | null
    head_commit: string | null
    conclusion: string | null
  }[]

  const selected = <T extends { project: string }>(rows: readonly T[]) =>
    windows.project ? rows.filter((row) => row.project === windows.project) : rows
  return deriveCycleCost({
    ...windows,
    landings: selected(landings),
    runs: selected(runs),
    reviewRounds: selected(reviewRounds),
    ciRecords: selected(
      ciRecords.flatMap((row): CycleCostCiRecord[] => {
        const project = projectsById.get(row.project_record_id)
        return project
          ? [
              {
                project: project.name,
                pullRequestNumber: row.pr_number,
                recordKind: row.record_kind,
                complete: row.complete === null ? null : row.complete === 1,
                workflowRunId: row.workflow_run_id === null ? null : Number(row.workflow_run_id),
                runAttempt: row.run_attempt,
                headCommit: row.head_commit,
                conclusion: row.conclusion,
              },
            ]
          : []
      }),
    ),
    unattributedLandings: selected(unattributedLandings),
  })
}
