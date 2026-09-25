import type { Finding } from '../../../shared/ratchet.ts'
import { fileNote, listHubNotes } from '../mcp/hub-notes.ts'
import { type Project, projects } from '../project/projects.ts'
import {
  type CanonAuditNote,
  type CanonAuditProjectPlan,
  type CanonAuditProjectRead,
  decideCanonAuditRun,
} from './canon-audit-decision.ts'
import { collectCanonLintInput } from './canon-files.ts'
import { lintCanon } from './canon-lint.ts'

type CanonAuditProjectResult = {
  project: string
  findings: number
  notes: string[]
}

export type CanonAuditResult = {
  dryRun: boolean
  projects: CanonAuditProjectResult[]
}

async function readProject(
  project: Pick<Project, 'name' | 'path'>,
): Promise<CanonAuditProjectRead> {
  const failures: string[] = []
  let findings: Finding[] | null = null
  try {
    findings = lintCanon(collectCanonLintInput(project.path)).findings
  } catch (error) {
    failures.push(
      `cannot read canon for project ${JSON.stringify(project.name)} at ${project.path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let notes: CanonAuditNote[] | null = null
  try {
    notes = await listHubNotes(project.name, { cwd: project.path })
  } catch (error) {
    failures.push(
      `cannot read note store for project ${JSON.stringify(project.name)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { project: project.name, path: project.path, findings, notes, failures }
}

async function filePlannedNotes(plan: CanonAuditProjectPlan): Promise<string[]> {
  const failures: string[] = []
  for (const filing of plan.notes) {
    try {
      await fileNote(
        filing.sameAs
          ? { text: filing.text, same_as: filing.sameAs }
          : { text: filing.text, new: true },
        { cwd: plan.path },
      )
    } catch (error) {
      failures.push(
        `cannot file note for project ${JSON.stringify(plan.project)} (${JSON.stringify(filing.text)}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return failures
}

export async function auditRepositoryCanon(input: { dryRun: boolean }): Promise<CanonAuditResult> {
  const reads: CanonAuditProjectRead[] = []
  for (const project of projects().filter(
    (candidate) => candidate.settings.managedContext === true,
  )) {
    reads.push(await readProject(project))
  }

  const { plans, failures } = decideCanonAuditRun(reads)

  if (!input.dryRun) {
    for (const plan of plans) failures.push(...(await filePlannedNotes(plan)))
  }
  if (failures.length) throw new Error(`canon audit could not complete:\n${failures.join('\n')}`)
  return {
    dryRun: input.dryRun,
    projects: plans.map(({ path: _, ...plan }) => ({
      ...plan,
      notes: plan.notes.map((filing) => filing.text),
    })),
  }
}
