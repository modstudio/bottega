// concern: cleanup sweep reclamation
/** Adapts ordinary branch and residue reclaim paths to sweep presentation. */
import { existsSync } from 'node:fs'
import { pruneProjectBranches } from '../branch/branches.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { reclaimResidue } from '../reclaim/reclaim-residue.ts'
import type { CleanupPresentation } from './cleanup.ts'

function recordedTrustOwners(): Map<string, number> {
  const owners = new Map<string, number>()
  const runs = db()
    .query('SELECT id, mcp_trust_path FROM run WHERE mcp_trust_path IS NOT NULL ORDER BY id')
    .all() as { id: number; mcp_trust_path: string }[]
  for (const run of runs) {
    try {
      const headings = JSON.parse(run.mcp_trust_path) as unknown
      if (!Array.isArray(headings)) continue
      for (const heading of headings) {
        if (typeof heading === 'string' && !owners.has(heading)) owners.set(heading, run.id)
      }
    } catch {
      /* observation from an older or incomplete row is not authority */
    }
  }
  return owners
}

function pathBelongsToProject(path: string, project: Project | null): boolean {
  return !project || path === project.path || path.startsWith(`${project.path}/`)
}

function reclaimAbsentTrustEntry(input: {
  dryRun: boolean
  heading: string
  path: string
  runId: number | undefined
  presentation: CleanupPresentation
}): boolean {
  if (!input.runId) {
    input.presentation.error(
      `could not reclaim grok trust entry for absent path ${input.path}: no recorded run owns ${input.heading}`,
    )
    return true
  }
  const reclaimed = reclaimResidue('trust', String(input.runId), { dryRun: input.dryRun })
  if (reclaimed.ok) {
    input.presentation.log(reclaimed.action)
    return false
  }
  input.presentation.error(
    `could not reclaim grok trust entry for absent path ${input.path}: ${reclaimed.action}`,
  )
  return true
}

export function reclaimAbsentTrustEntries(input: {
  dryRun: boolean
  selectedProject: Project | null
  headings: readonly string[]
  pathFromHeading: (heading: string) => string | null
  presentation: CleanupPresentation
}): boolean {
  const trustOwners = recordedTrustOwners()
  let failed = false
  for (const heading of input.headings) {
    const path = input.pathFromHeading(heading)
    if (!path || existsSync(path)) continue
    if (!pathBelongsToProject(path, input.selectedProject)) continue
    const entryFailed = reclaimAbsentTrustEntry({
      dryRun: input.dryRun,
      heading,
      path,
      runId: trustOwners.get(heading),
      presentation: input.presentation,
    })
    failed ||= entryFailed
  }
  return failed
}

export function pruneSweptProjectBranches(input: {
  dryRun: boolean
  projects: readonly Project[]
  presentation: CleanupPresentation
}): boolean {
  let failed = false
  for (const project of input.projects) {
    try {
      const report = pruneProjectBranches({ project: project.name, dryRun: input.dryRun })
      const deleted = input.dryRun ? report.wouldDelete.length : report.deleted.length
      input.presentation.log(
        `${project.name} branches: ${input.dryRun ? 'would delete' : 'deleted'} ${deleted}, kept ${report.kept.length}`,
      )
      for (const error of report.errors)
        input.presentation.error(`${project.name} branches: ${error}`)
      failed ||= report.errors.length > 0
    } catch (error) {
      failed = true
      input.presentation.error(
        `${project.name} branches: classification unavailable; skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return failed
}
