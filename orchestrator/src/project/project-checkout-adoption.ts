// concern: project-checkout-adoption
/** Gathers checkout evidence and registers hosted projects found under the clone root. */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitAt } from '../../../shared/git.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { recordMemberships, requireRecordSpaceMembership } from '../record/record-space.ts'
import {
  decideProjectCheckoutAdoptions,
  isNotProjectCheckoutRegistrationCandidate,
  type ProjectCheckoutFacts,
} from './project-checkout-adoption-decision.ts'
import { type AddProjectInput, addProject } from './project-commands.ts'
import type { ProjectSettings } from './project-settings.ts'
import { projects, sniffStack } from './projects.ts'

export type ProjectCheckoutAdoptionReport =
  | { status: 'registered'; message: string }
  | { status: 'missing'; message: string }
  | { status: 'refused'; message: string }

export function hostedProjectAddInput(project: RecordProject, path: string): AddProjectInput {
  return {
    path,
    name: project.name,
    stack: project.stack ?? sniffStack(path),
    canon: project.canon ?? true,
    settings: (project.settings ?? {}) as ProjectSettings,
    allowIncomplete: false,
    selectedSpace: project.spaceId,
  }
}

export function missingCheckoutMessage(input: {
  name: string
  space: string
  path: string
}): string {
  return `${input.name} is in space ${input.space} but not checked out at ${input.path}; clone it there, or register a checkout kept elsewhere with: ${PLATFORM_SLUG} project add <path> --name ${input.name}`
}

function gitValue(path: string, args: string[], description: string): string {
  const result = gitAt(path, args, { budget: 'git-probe' })
  if (result.timedOut) {
    throw new Error(
      `git timed out while reading ${description}; run \`git -C ${path} ${args.join(' ')}\`, fix the checkout, then sign in again`,
    )
  }
  if (result.code !== 0) return ''
  return result.stdout.trim()
}

function checkoutFacts(path: string): ProjectCheckoutFacts {
  if (!existsSync(path)) {
    return {
      directoryExists: false,
      topLevel: false,
      linkedWorktree: false,
      bareRepository: false,
      originUrl: false,
    }
  }
  try {
    if (!statSync(path).isDirectory()) {
      return {
        directoryExists: true,
        topLevel: false,
        linkedWorktree: false,
        bareRepository: false,
        originUrl: false,
        refusal: `the candidate path is not a directory; move it aside, check out the project at ${path}, then sign in again`,
      }
    }
    const absolute = realpathSync(path)
    const top = gitValue(
      path,
      ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      'the work-tree top',
    )
    const inside = gitValue(path, ['rev-parse', '--is-inside-work-tree'], 'work-tree membership')
    const bare = gitValue(path, ['rev-parse', '--is-bare-repository'], 'bare-repository state')
    const gitDir = gitValue(
      path,
      ['rev-parse', '--path-format=absolute', '--git-dir'],
      'the git directory',
    )
    const commonDir = gitValue(
      path,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      'the git common directory',
    )
    const linkedRoot = commonDir ? join(commonDir, 'worktrees') : ''
    return {
      directoryExists: true,
      topLevel: inside === 'true' && Boolean(top) && realpathSync(top) === absolute,
      linkedWorktree: Boolean(gitDir && linkedRoot && gitDir.startsWith(`${linkedRoot}${sep}`)),
      bareRepository: bare === 'true',
      originUrl: Boolean(
        gitValue(path, ['config', '--get', 'remote.origin.url'], 'remote.origin.url'),
      ),
    }
  } catch (error) {
    return {
      directoryExists: true,
      topLevel: false,
      linkedWorktree: false,
      bareRepository: false,
      originUrl: false,
      refusal: `${error instanceof Error ? error.message : String(error)}; inspect the checkout at ${path}, then sign in again`,
    }
  }
}

type ProjectCheckoutAdoptionDependencies = {
  readPinnedIdentity: typeof readHostedConfigIdentity
  readCloneRoot: () => string
}

const projectCheckoutAdoptionDependencies: ProjectCheckoutAdoptionDependencies = {
  readPinnedIdentity: readHostedConfigIdentity,
  readCloneRoot: () => resolve(readMachineValue('projects.clone_root')),
}

export async function registerCheckedOutHostedProjects(
  dependencies: ProjectCheckoutAdoptionDependencies = projectCheckoutAdoptionDependencies,
): Promise<ProjectCheckoutAdoptionReport[]> {
  const pinned = dependencies.readPinnedIdentity()
  if (!pinned) {
    return [
      {
        status: 'missing',
        message: `projects checked out under ${dependencies.readCloneRoot()} are registered once this machine is initialized: ${PLATFORM_SLUG} config machine init`,
      },
    ]
  }
  const client = recordApiClient()
  const identity = await recordMemberships(client)
  const membership = identity.memberships.find((row) => row.spaceId === pinned.spaceId)
  const slug = membership?.slug ?? pinned.spaceId
  const hostedProjects = await client.listProjects({ destinationSpaceId: pinned.spaceId })
  const localProjects = [...projects(), ...projects({ retired: true })]
  const localProjectNames = new Set(localProjects.map((project) => project.name))
  const cloneRoot = dependencies.readCloneRoot()
  const candidates = new Map<string, { path: string; facts: ProjectCheckoutFacts }>()
  for (const project of hostedProjects) {
    if (isNotProjectCheckoutRegistrationCandidate(project, localProjectNames)) continue
    const path = join(cloneRoot, project.name)
    candidates.set(project.name, { path, facts: checkoutFacts(path) })
  }
  const outcomes = decideProjectCheckoutAdoptions({
    hostedProjects,
    localProjects,
    candidates,
  })
  const reports: ProjectCheckoutAdoptionReport[] = []
  for (const outcome of outcomes) {
    const { project, path } = outcome
    if (outcome.kind === 'missing') {
      reports.push({
        status: 'missing',
        message: missingCheckoutMessage({ name: project.name, space: slug, path }),
      })
      continue
    }
    if (outcome.kind === 'refuse') {
      reports.push({
        status: 'refused',
        message: `${project.name} at ${path} not registered: ${outcome.message}`,
      })
      continue
    }
    try {
      const { project: registered } = await addProject(
        hostedProjectAddInput(project, path),
        requireRecordSpaceMembership,
      )
      reports.push({
        status: 'registered',
        message: `registered ${project.name} at ${path} (trunk ${registered.settings.trunk}); undo: ${PLATFORM_SLUG} project remove ${project.name}`,
      })
    } catch (error) {
      reports.push({
        status: 'refused',
        message: `${project.name} at ${path} not registered: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return reports
}

export async function reportCheckedOutHostedProjects(
  presentation: { log(value: string): void },
  retryCommand: string,
): Promise<void> {
  try {
    for (const report of await registerCheckedOutHostedProjects()) presentation.log(report.message)
  } catch (error) {
    presentation.log(
      `checked-out project registration failed: ${error instanceof Error ? error.message : String(error)}; run \`${retryCommand}\` again`,
    )
  }
}
