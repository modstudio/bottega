// concern: project-checkout-adoption-decision
/** Decides which hosted projects can be adopted from this machine's clone root. */

import type { RecordProject } from '../../../shared/record-project-contract.ts'

export type ProjectCheckoutFacts = {
  directoryExists: boolean
  topLevel: boolean
  linkedWorktree: boolean
  bareRepository: boolean
  originUrl: boolean
  refusal?: string
}

export type ProjectCheckoutAdoptionOutcome =
  | { kind: 'adopt'; project: RecordProject; path: string }
  | { kind: 'missing'; project: RecordProject; path: string }
  | { kind: 'refuse'; project: RecordProject; path: string; message: string }

type Candidate = { path: string; facts: ProjectCheckoutFacts }

function checkoutRefusal(project: RecordProject, candidate: Candidate): string | null {
  const { path, facts } = candidate
  if (facts.refusal) return facts.refusal
  if (facts.linkedWorktree)
    return `linked worktrees cannot be registered; check out a standalone clone at ${path}, then sign in again`
  if (facts.bareRepository)
    return `bare repositories cannot be registered; check out a non-bare clone at ${path}, then sign in again`
  if (!facts.topLevel)
    return `the directory is not the top of a git work tree; check out ${project.name} at ${path}, then sign in again`
  if (!facts.originUrl)
    return `remote.origin.url is unset; run \`git -C ${path} remote add origin <url>\`, then sign in again`
  return null
}

function checkoutOutcome(
  project: RecordProject,
  candidate: Candidate,
): ProjectCheckoutAdoptionOutcome {
  const { path, facts } = candidate
  if (!facts.directoryExists) return { kind: 'missing', project, path }
  const message = checkoutRefusal(project, candidate)
  return message ? { kind: 'refuse', project, path, message } : { kind: 'adopt', project, path }
}

export function decideProjectCheckoutAdoptions(input: {
  hostedProjects: readonly RecordProject[]
  localProjects: readonly { name: string; retiredAt: string | null }[]
  candidates: ReadonlyMap<string, { path: string; facts: ProjectCheckoutFacts }>
}): ProjectCheckoutAdoptionOutcome[] {
  const localProjectNames = new Set(input.localProjects.map((project) => project.name))
  const outcomes: ProjectCheckoutAdoptionOutcome[] = []
  for (const project of input.hostedProjects) {
    if (project.retiredAt || localProjectNames.has(project.name)) continue
    const candidate = input.candidates.get(project.name)
    if (!candidate) continue
    outcomes.push(checkoutOutcome(project, candidate))
  }
  return outcomes
}
