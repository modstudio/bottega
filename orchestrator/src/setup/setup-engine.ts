// concern: setup-engine
/** Turns setup facts into proposals and ruling-shaped questions. Pure: no store, process, or filesystem. */

import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { Project, ProjectSettings } from '../project/projects.ts'
import type { RepositoryFacts } from './repository-facts.ts'
import type { SetupFacts } from './setup-facts.ts'
import {
  harnessMcpServers,
  type McpReadback,
  type McpServer,
  manualMcpInstructions,
  sameMcpRegistration,
} from './setup-mcp.ts'
import { INFERRED_RECIPE_PATH, inferredRecipeContent, proposedGate } from './setup-toolchain.ts'

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
export type SetupAgent = { name: string; harness: string; enabled: number | boolean }
export type SetupProposal = {
  repository: RepositoryFacts
  current: Project | null
  project: { name: string; path: string; stack: string | null; settings: ProjectSettings }
  prefixQuestionId: string | null
  trunkQuestionId: string | null
  recipeQuestionId: string | null
  recipeContent: string | null
}
type SetupRegistrationProposal = {
  harness: keyof SetupFacts['harnesses']
  bin: string
  server: McpServer
  current: McpReadback
  questionId: string | null
  state: 'absent' | 'same' | 'different' | 'unreadable'
}
export type SetupPlan = {
  facts: { machine: SetupFacts; repositories: RepositoryFacts[] }
  proposals: SetupProposal[]
  registrations: SetupRegistrationProposal[]
  questions: SetupQuestion[]
  notices: SetupNotice[]
}

const questionId = (path: string, field: string) => `project:${encodeURIComponent(path)}:${field}`
const registrationQuestionId = (harness: string, server?: string) =>
  `harness:${harness}:mcp-${server ? `replace-${server}` : 'register'}`

type HarnessFacts = SetupFacts['harnesses'][keyof SetupFacts['harnesses']]

function proposeHarnessRegistrations(
  harness: keyof SetupFacts['harnesses'],
  facts: HarnessFacts,
  servers: McpServer[],
  questions: SetupQuestion[],
  notices: SetupNotice[],
): SetupRegistrationProposal[] {
  if (!facts.path || !facts.mcp) return []
  if (facts.mcp.support === 'manual') {
    notices.push({
      message: `${harness} cannot register a local MCP server non-interactively through its CLI`,
      fix: manualMcpInstructions(harness),
    })
    return []
  }
  const desired = servers.filter((server) => harnessMcpServers(harness).includes(server.name))
  const absent = desired.filter(
    (server) => facts.mcp?.registrations[server.name]?.status === 'absent',
  )
  const absentQuestionId = absent.length ? registrationQuestionId(harness) : null
  if (absentQuestionId) {
    const recommendation = facts.auth === 'signed-out' ? 'skip' : 'register'
    questions.push({
      id: absentQuestionId,
      question: `Register ${absent.map((server) => server.name).join(' and ')} in ${harness} at user scope?`,
      options: [
        {
          id: 'register',
          label: 'Register',
          why: `Makes ${PLATFORM_NAME}'s selected MCP servers available in ${harness}.`,
        },
        {
          id: 'skip',
          label: 'Skip',
          why: `Leaves ${harness}'s user MCP configuration unchanged.`,
        },
      ],
      recommendation,
      why:
        facts.auth === 'signed-out'
          ? `${harness} is installed but signed out.`
          : `${harness} is installed and does not have the selected servers.`,
    })
  }
  return desired.map((server) => {
    const current = facts.mcp!.registrations[server.name] ?? {
      status: 'unreadable' as const,
      detail: 'registration was not captured',
    }
    if (sameMcpRegistration(current, server)) {
      return { harness, bin: facts.path!, server, current, questionId: null, state: 'same' }
    }
    if (current.status === 'absent') {
      return {
        harness,
        bin: facts.path!,
        server,
        current,
        questionId: absentQuestionId,
        state: 'absent',
      }
    }
    const replaceQuestionId = registrationQuestionId(harness, server.name)
    questions.push({
      id: replaceQuestionId,
      question: `Replace the existing ${server.name} MCP registration in ${harness}?`,
      options: [
        {
          id: 'keep',
          label: 'Keep existing',
          why: `Preserves ${harness}'s current ${server.name} registration.`,
        },
        {
          id: 'replace',
          label: 'Replace',
          why: `Updates ${server.name} to ${PLATFORM_NAME}'s current command and arguments.`,
        },
      ],
      recommendation: 'keep',
      why:
        current.status === 'registered'
          ? `The registered command or arguments differ from ${PLATFORM_NAME}.`
          : `The existing registration could not be read exactly: ${current.detail}`,
    })
    if (current.status === 'unreadable')
      notices.push({
        message: `${harness} ${server.name} registration could not be read exactly: ${current.detail}`,
        fix: `${facts.path} ${harness === 'grok' ? 'mcp list --json' : `mcp get ${server.name}`}`,
      })
    return {
      harness,
      bin: facts.path!,
      server,
      current,
      questionId: replaceQuestionId,
      state: current.status === 'registered' ? 'different' : 'unreadable',
    }
  })
}

function proposeMcpRegistrations(
  machine: SetupFacts,
  servers: McpServer[],
  questions: SetupQuestion[],
  notices: SetupNotice[],
): SetupRegistrationProposal[] {
  return (
    Object.entries(machine.harnesses ?? {}) as [keyof SetupFacts['harnesses'], HarnessFacts][]
  ).flatMap(([harness, facts]) =>
    proposeHarnessRegistrations(harness, facts, servers, questions, notices),
  )
}

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

const UNREGISTERED_HARNESSES = [
  { fact: 'claude', harness: 'claude-code' },
  { fact: 'opencode', harness: 'opencode' },
  { fact: 'goose', harness: 'goose' },
] as const

function builtInAgentNotice(
  name: 'codex' | 'grok',
  machine: SetupFacts,
  agent: SetupAgent | undefined,
): SetupNotice | null {
  if (!agent) return null
  const harness = machine.harnesses?.[name]
  if (!agent.enabled) {
    return harness?.path && harness.auth === 'signed-in'
      ? {
          message: `${name} harness is installed and signed in but the ${name} agent is disabled`,
          fix: `orch agent set ${name} --enabled true`,
        }
      : null
  }
  if (!harness?.path) {
    return {
      message: `${name} agent is enabled but the ${name} harness is not installed`,
      fix: `install ${name}, or orch agent set ${name} --enabled false --reason "${name} is not installed on this machine"`,
    }
  }
  if (harness.auth === 'signed-out') {
    return {
      message: `${name} agent is enabled but the ${name} harness is not signed in`,
      fix: `sign in to ${name}, or orch agent set ${name} --enabled false --reason "${name} is not signed in on this machine"`,
    }
  }
  return harness.auth === 'unknown'
    ? {
        message: `the sign-in state of ${name} could not be established`,
        fix: `check ${name} sign-in and re-run orch setup plan`,
      }
    : null
}

function agentNotices(machine: SetupFacts, agents: SetupAgent[]): SetupNotice[] {
  const notices: SetupNotice[] = []
  for (const name of ['codex', 'grok'] as const) {
    const agent = agents.find((candidate) => candidate.name === name)
    const notice = builtInAgentNotice(name, machine, agent)
    if (notice) notices.push(notice)
  }
  for (const candidate of UNREGISTERED_HARNESSES) {
    if (
      machine.harnesses?.[candidate.fact]?.path &&
      !agents.some((agent) => agent.harness === candidate.harness)
    ) {
      notices.push({
        message: `${candidate.harness} harness is installed but unregistered`,
        fix: `orch agent add <name> --harness ${candidate.harness} --backend <backend> --model <model>`,
      })
    }
  }
  return notices
}

function proposeProjectToolchain(
  repository: RepositoryFacts,
  current: Project | null,
  questions: SetupQuestion[],
  notices: SetupNotice[],
): { gate: string | null; recipeQuestionId: string | null; recipeContent: string | null } {
  const gate = current?.settings.gate ?? proposedGate(repository)
  if (!current?.settings.gate && !gate) {
    notices.push({
      message: `no gate was detected for ${repository.name}`,
      fix: `orch project set ${current?.name ?? repository.name} --settings '{"gate":"..."}'`,
    })
  }
  const recipeContent = inferredRecipeContent(repository)
  if (current?.settings.worktree?.recipePath || repository.recipeFileExists || !recipeContent) {
    return { gate, recipeQuestionId: null, recipeContent }
  }
  const recipeQuestionId = questionId(repository.path, 'worktree-recipe')
  questions.push({
    id: recipeQuestionId,
    question: `Write an inferred Files-level worktree recipe for ${repository.name}?`,
    options: [
      {
        id: 'write',
        label: 'Write recipe',
        why: `Creates ${INFERRED_RECIPE_PATH} with a frozen dependency install step.`,
      },
      {
        id: 'skip',
        label: 'Skip',
        why: 'Leaves the repository and its worktree recipe setting unchanged.',
      },
    ],
    recommendation: 'write',
    why: 'A tracked recipe gives writing worktrees the project dependencies without adding environment, database, or serve access.',
  })
  return { gate, recipeQuestionId, recipeContent }
}

export function proposeSetup(
  machine: SetupFacts,
  repositories: RepositoryFacts[],
  register: Project[],
  agents: SetupAgent[],
  repositoryNotices: SetupNotice[] = [],
  servers: McpServer[] = [],
): SetupPlan {
  const occupied = new Set(
    register
      .flatMap((project) => project.settings.keyPrefixes ?? [])
      .map((prefix) => prefix.toUpperCase()),
  )
  const questions: SetupQuestion[] = []
  const notices = [
    ...machineNotices(machine),
    ...agentNotices(machine, agents),
    ...repositoryNotices,
  ]
  const registrations = proposeMcpRegistrations(machine, servers, questions, notices)
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
    const { gate, recipeQuestionId, recipeContent } = proposeProjectToolchain(
      repository,
      current,
      questions,
      notices,
    )
    const settings: ProjectSettings = {
      ...current?.settings,
      ...(proposedPrefix ? { keyPrefixes: [proposedPrefix] } : {}),
      ...(current?.settings.tracker
        ? { tracker: current.settings.tracker }
        : { tracker: { kind: 'hub', protocol: 'hub' } }),
      ...(proposedTrunk ? { trunk: proposedTrunk } : {}),
      ...(gate ? { gate } : {}),
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
      recipeQuestionId,
      recipeContent,
    }
  })
  return { facts: { machine, repositories }, proposals, registrations, questions, notices }
}
