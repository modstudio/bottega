// concern: review-scope-proposal
/** Reads proposal facts at the CLI edge and delegates the proposal decision. */

import { Database } from 'bun:sqlite'
import { readdirSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { categorizeFile } from '../../../shared/file-kind.ts'
import { DB_PATH } from '../database/database-location.ts'
import {
  parseStoredReviewPathSet,
  parseStoredReviewSettings,
  reviewRunEvidenceSql,
} from './review-evidence-sql.ts'
import {
  proposeReviewScopes,
  type ReviewScopeProject,
  type ReviewScopeRun,
  renderReviewScopeProposalHuman,
} from './review-scope-proposal.ts'

type ScopeProposalFlags = { has(name: string): boolean }
type ScopeProposalPresentation = { log(message: string): void }

type ProjectRow = { name: string; path: string; settings: string }
type EvidenceRow = {
  project: string
  lens_id: string
  lens: string
  completed_at: string | null
  path_set: string | null
  finding_id: string | null
  disposition: string | null
  triaged_severity: string | null
}

function topLevelDirectories(project: string, path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git' && entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cannot read registered path for project ${project} at ${path}: ${detail}; ` +
        `fix the checkout or run ${PLATFORM_SLUG} project set ${project} --path <path>`,
    )
  }
}

function reviewScopeProposal(database: Database): ReturnType<typeof proposeReviewScopes> {
  const projects = database
    .query('SELECT name,path,settings FROM project WHERE retired_at IS NULL ORDER BY name')
    .all() as ProjectRow[]
  const evidence = database
    .query(
      `SELECT p.name AS project,rl.record_id AS lens_id,rl.lens,r.completed_at,r.path_set,
              rf.record_id AS finding_id,rf.disposition,rf.triaged_severity
       FROM review_lens rl
       JOIN review r ON r.record_id=rl.review_record_id
       JOIN run ON run.record_id=rl.run_record_id
       JOIN project p ON p.record_id=r.project_record_id
       LEFT JOIN review_finding rf ON rf.review_lens_record_id=rl.record_id
       WHERE ${reviewRunEvidenceSql('run', 'rl')}
       ORDER BY p.name,r.recorded_at,r.record_id,rl.record_id,rf.ordinal`,
    )
    .all() as EvidenceRow[]
  const byProject = new Map<string, Map<string, ReviewScopeRun>>()
  for (const row of evidence) {
    const runs = byProject.get(row.project) ?? new Map<string, ReviewScopeRun>()
    const recordedPaths = parseStoredReviewPathSet(row.path_set)
    const run = runs.get(row.lens_id) ?? {
      id: row.lens_id,
      lens: row.lens,
      paths: recordedPaths?.map((path) => ({ path, kind: categorizeFile(path) })) ?? null,
      complete: row.completed_at !== null,
      findings: [],
    }
    if (row.finding_id)
      run.findings.push({
        disposition: row.disposition,
        triaged_severity: row.triaged_severity,
      })
    runs.set(row.lens_id, run)
    byProject.set(row.project, runs)
  }

  const inputs: ReviewScopeProject[] = projects.map((project) => ({
    project: project.name,
    topLevelDirectories: topLevelDirectories(project.name, project.path),
    review: parseStoredReviewSettings(project.settings) ?? { lenses: [] },
    runs: [...(byProject.get(project.name)?.values() ?? [])],
  }))
  return proposeReviewScopes(inputs)
}

export function scopeProposalReviewCommand(
  flags: ScopeProposalFlags,
  { log }: ScopeProposalPresentation,
): void {
  const database = new Database(DB_PATH, { readonly: true })
  try {
    const report = reviewScopeProposal(database)
    log(flags.has('json') ? JSON.stringify(report) : renderReviewScopeProposalHuman(report))
  } finally {
    database.close()
  }
}
