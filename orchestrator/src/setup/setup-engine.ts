// concern: setup-engine
/** Turns setup facts into proposals and ruling-shaped questions. Pure: no store, process, or filesystem. */
import type { Project, ProjectSettings } from '../project/projects.ts'
import type { RepositoryFacts } from './repository-facts.ts'
import type { SetupFacts } from './setup-facts.ts'

export type SetupQuestion = {
  id: string
  question: string
  options: {
    id: string
    label: string
    why: string
    effect?: { trunk: string | null }
  }[]
  recommendation: string
  why: string
}

export type SetupNotice = { message: string; fix: string | null }
export type SetupProposal = {
  repository: RepositoryFacts
  current: Project | null
  project: { name: string; path: string; stack: string | null; settings: ProjectSettings }
  prefixQuestionId: string | null
  trunkQuestionId: string | null
}
export type SetupPlan = {
  facts: { machine: SetupFacts; repositories: RepositoryFacts[] }
  proposals: SetupProposal[]
  questions: SetupQuestion[]
  notices: SetupNotice[]
}

const questionId = (path: string, field: string) => `project:${encodeURIComponent(path)}:${field}`

export function deriveKeyPrefix(name: string, occupied: ReadonlySet<string>): string {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[^A-Z]+/, '')
  const base = (letters || 'P').slice(0, 5)
  for (let suffix = 0; ; suffix++) {
    const tail = suffix === 0 ? '' : String(suffix)
    const candidate = `${base.slice(0, 5 - tail.length)}${tail}`
    if (candidate !== 'TASK' && !occupied.has(candidate)) return candidate
  }
}

function machineNotices(machine: SetupFacts): SetupNotice[] {
  const notices: SetupNotice[] = []
  if (!machine.git.path) notices.push({ message: 'git is missing', fix: 'install git' })
  if (!machine.gh.path) notices.push({ message: 'gh is missing', fix: 'install gh' })
  else if (!machine.gh.loggedIn)
    notices.push({ message: 'gh is signed out', fix: 'gh auth login --hostname github.com' })
  return notices
}

export function proposeSetup(
  machine: SetupFacts,
  repositories: RepositoryFacts[],
  register: Project[],
  repositoryNotices: SetupNotice[] = [],
): SetupPlan {
  const occupied = new Set(
    register
      .flatMap((project) => project.settings.keyPrefixes ?? [])
      .map((prefix) => prefix.toUpperCase()),
  )
  const questions: SetupQuestion[] = []
  const notices = [...machineNotices(machine), ...repositoryNotices]
  const proposals = repositories.map((repository) => {
    if (repository.inspectionTimedOut) {
      notices.push({
        message: `git inspection timed out for ${repository.name} at ${repository.path}`,
        fix: `git -C ${repository.path} status`,
      })
    }
    const current = register.find((project) => project.path === repository.path) ?? null
    const currentPrefixes = current?.settings.keyPrefixes ?? []
    let prefixQuestionId: string | null = null
    let proposedPrefix: string | undefined
    if (currentPrefixes.length === 0) {
      proposedPrefix = deriveKeyPrefix(repository.name, occupied)
      occupied.add(proposedPrefix)
      prefixQuestionId = questionId(repository.path, 'key-prefix')
      questions.push({
        id: prefixQuestionId,
        question: `Which task key prefix should ${repository.name} use?`,
        options: [
          {
            id: proposedPrefix,
            label: proposedPrefix,
            why: 'Uppercase letters and digits derived from the repository name and unique in the register.',
          },
        ],
        recommendation: proposedPrefix,
        why: 'Every project needs a short, unique task key prefix for attribution.',
      })
    }

    let trunkQuestionId: string | null = null
    let proposedTrunk: string | undefined
    if (current?.settings.trunk) {
      proposedTrunk = current.settings.trunk
    } else if (repository.currentBranch) {
      if (
        repository.remoteDefaultBranch &&
        repository.remoteDefaultBranch !== repository.currentBranch
      ) {
        trunkQuestionId = questionId(repository.path, 'trunk')
        questions.push({
          id: trunkQuestionId,
          question: `Which trunk setting should ${repository.name} use?`,
          options: [
            {
              id: 'unset',
              label: 'Leave trunk unset',
              why: `The register requires trunk to be the checked-out branch, and the remote default is ${repository.remoteDefaultBranch}.`,
              effect: { trunk: null },
            },
            {
              id: 'current',
              label: `Use the current branch ${repository.currentBranch} as trunk`,
              why: 'The current symbolic HEAD is the only branch the register can accept now.',
              effect: { trunk: repository.currentBranch },
            },
          ],
          recommendation: 'unset',
          why: 'The checked-out branch and remote default disagree.',
        })
        notices.push({
          message: `check out ${repository.remoteDefaultBranch} and re-run setup to declare it as trunk`,
          fix: `git -C ${repository.path} switch ${repository.remoteDefaultBranch}`,
        })
      } else {
        proposedTrunk = repository.currentBranch
      }
    } else {
      notices.push({
        message: repository.remoteDefaultBranch
          ? `${repository.name} has detached HEAD; remote default is ${repository.remoteDefaultBranch}; leaving trunk unset`
          : `${repository.name} has detached HEAD; leaving trunk unset`,
        fix: null,
      })
    }
    const settings: ProjectSettings = {
      ...current?.settings,
      ...(proposedPrefix ? { keyPrefixes: [proposedPrefix] } : {}),
      ...(current?.settings.tracker
        ? { tracker: current.settings.tracker }
        : { tracker: { kind: 'hub', protocol: 'hub' } }),
      ...(proposedTrunk ? { trunk: proposedTrunk } : {}),
    }
    return {
      repository,
      current,
      project: {
        name: current?.name ?? repository.name,
        path: repository.path,
        stack: current?.stack ?? repository.stack,
        settings,
      },
      prefixQuestionId,
      trunkQuestionId,
    }
  })
  return { facts: { machine, repositories }, proposals, questions, notices }
}
