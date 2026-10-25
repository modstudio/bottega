// concern: agent-commands
/** Owns agent registry mutations and catalogue presentation. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { flagValue } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { probeAgent, recordSuccessfulRegistrationProbe } from './agent-probe.ts'
import {
  AGENTS,
  type AgentMutation,
  addAgent,
  agentRows,
  type Backend,
  type Harness,
  type RegistrationProbeResult,
  removeAgent,
  setAgent,
} from './agent-registry.ts'
import {
  available,
  ensureLocalHealth,
  harnessInstalled,
  modelHostModel,
  unavailableReason,
} from './model-host.ts'

type Presentation = { log(value: string): void; setExitCode(code: number): void }
type AgentCommandVerb = 'add' | 'set' | 'remove' | 'probe' | 'show'
type AgentCommandHandler = (
  name: string,
  argv: string[],
  presentation: Presentation,
  dependencies: AgentCommandDependencies,
) => void | Promise<void>
type AgentCommandDependencies = { probeAgent: typeof probeAgent }

const agentCommandDependencies: AgentCommandDependencies = { probeAgent }

const AGENT_COMMAND_HANDLERS: Record<AgentCommandVerb, AgentCommandHandler> = {
  add: addCommand,
  set: (name, argv, presentation) => {
    presentation.log(JSON.stringify(setAgent(name, mutation(argv))))
  },
  remove: (name, _argv, presentation) => {
    removeAgent(name)
    presentation.log(`removed ${name}`)
  },
  probe: (name, _argv, presentation, dependencies) =>
    probeCommand(name, presentation, dependencies),
  show: (name, _argv, presentation) => showCommand(name, presentation),
}

export const AGENT_COMMAND_VERBS = Object.keys(AGENT_COMMAND_HANDLERS) as AgentCommandVerb[]

function isAgentCommandVerb(value: string | undefined): value is AgentCommandVerb {
  return AGENT_COMMAND_VERBS.some((verb) => verb === value)
}

const parseJobs = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value === 'any'
      ? null
      : value.split(',').map((entry) => entry.trim())

function assertApiKeyFlags(argv: string[], value: string | undefined): void {
  if (value !== undefined && argv.includes('--clear-api-key-secret'))
    throw new Error('--api-key-secret and --clear-api-key-secret are mutually exclusive')
}

function booleanFlag(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value !== 'true' && value !== 'false') throw new Error(`--${name} must be true or false`)
  return value === 'true'
}

function mutation(argv: string[]): AgentMutation {
  const flag = (name: string) => flagValue(argv, name)
  const apiKeySecret = flag('api-key-secret')
  assertApiKeyFlags(argv, apiKeySecret)
  const enabled = booleanFlag('enabled', flag('enabled'))
  const billing = flag('billing')
  const routeMetered = booleanFlag('route-metered', flag('route-metered'))
  const trainsOnInputs = booleanFlag('trains-on-inputs', flag('trains-on-inputs'))
  const context = flag('context-tokens'),
    jobs = flag('jobs'),
    prefer = flag('prefer'),
    maxConcurrent = flag('max-concurrent')
  return {
    ...(flag('harness') ? { harness: flag('harness') as Harness } : {}),
    ...(flag('backend') ? { backend: flag('backend') as Backend } : {}),
    ...(flag('model') ? { model: flag('model')! } : {}),
    ...(flag('base-url') ? { baseUrl: flag('base-url')! } : {}),
    ...(apiKeySecret ? { apiKeySecret } : {}),
    ...(argv.includes('--clear-api-key-secret') ? { apiKeySecret: null } : {}),
    ...(billing ? { billing: billing as AgentMutation['billing'] } : {}),
    ...(routeMetered !== undefined ? { routeMetered } : {}),
    ...(trainsOnInputs !== undefined ? { trainsOnInputs } : {}),
    ...(context ? { contextTokens: Number(context) } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(flag('reason') !== undefined ? { reason: flag('reason')! } : {}),
    ...(jobs !== undefined ? { jobs: parseJobs(jobs) } : {}),
    ...(prefer !== undefined ? { preferredJobs: parseJobs(prefer) ?? [] } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent: Number(maxConcurrent) } : {}),
  }
}

export async function agentCommand(
  argv: string[],
  presentation: Presentation,
  dependencies: AgentCommandDependencies = agentCommandDependencies,
): Promise<void> {
  const sub = argv[1],
    name = argv[2]
  if (!isAgentCommandVerb(sub)) {
    throw new Error(
      `unknown agent command "${sub ?? ''}"; valid commands: ${AGENT_COMMAND_VERBS.join(', ')}`,
    )
  }
  if (!name)
    throw new Error(
      `an agent name is required\nusage: ${PLATFORM_SLUG} agent ${sub} <name> [options]`,
    )
  await AGENT_COMMAND_HANDLERS[sub](name, argv, presentation, dependencies)
}

function addCommand(name: string, argv: string[], presentation: Presentation): void {
  const input = mutation(argv)
  if (!input.model) {
    const configured = modelHostModel().trim()
    if (!configured)
      throw new Error(
        'agent add requires --model or BOTTEGA_MODEL_HOST_MODEL\ncleared by: pass --model or set BOTTEGA_MODEL_HOST_MODEL',
      )
    input.model = configured
  }
  presentation.log(JSON.stringify(addAgent(name, input)))
}

async function probeCommand(
  name: string,
  presentation: Presentation,
  dependencies: AgentCommandDependencies,
): Promise<void> {
  const result = await dependencies.probeAgent(name, {
    path: process.env.PATH,
    environment: process.env,
  })
  const exhaustedBudget = result.budget?.kind === 'exhausted' ? result.budget : null
  const billingHold = exhaustedBudget !== null
  if (result.ok && !billingHold) recordSuccessfulRegistrationProbe(name)
  presentation.log(JSON.stringify(result, null, 2))
  if (exhaustedBudget) presentation.log(exhaustedBudget.refusal)
  if (!result.ok || billingHold) presentation.setExitCode(1)
}

function showCommand(name: string, presentation: Presentation): void {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const judged = db()
    .query(
      'SELECT job, COUNT(*) AS count FROM run r JOIN score s ON s.run_record_id=r.record_id WHERE r.agent=? GROUP BY job ORDER BY job',
    )
    .all(name) as { job: string; count: number }[]
  presentation.log(
    JSON.stringify(
      {
        ...row,
        caps: JSON.parse(row.caps),
        probeResult: row.probe_result ? JSON.parse(row.probe_result) : null,
        judged,
      },
      null,
      2,
    ),
  )
}

export function agentReadinessPresentation(facts: {
  name: string
  enabled: boolean
  disabledReason: string | null | undefined
  executableFound: boolean
  probedAt: string | null | undefined
  available: boolean
  unavailableReason: string | null
  probeBudgetKind?: NonNullable<RegistrationProbeResult['budget']>['kind']
}): string {
  if (!facts.enabled) return `disabled — ${facts.disabledReason}`
  if (!facts.executableFound) return 'not installed'
  if (!facts.probedAt)
    return `installed but not probed — ${PLATFORM_SLUG} agent probe ${facts.name}`
  if (!facts.available) return `unavailable — ${facts.unavailableReason}`
  if (facts.probeBudgetKind === 'unknown') return 'OpenRouter key budget not verified'
  return 'ready'
}

export async function agentsCommand(json: boolean, presentation: Presentation): Promise<void> {
  const payload = await agentsPayload()
  if (json) {
    presentation.log(JSON.stringify(payload))
    return
  }
  const rows = Object.values(AGENTS).map((agent) => ({
    agent,
    readiness: agentReadinessPresentation({
      name: agent.name,
      enabled: agent.enabled !== false,
      disabledReason: agent.disabledReason,
      executableFound: harnessInstalled(agent.name),
      probedAt: agent.probedAt,
      available: available(agent.name),
      unavailableReason: unavailableReason(agent.name),
      probeBudgetKind: (agent.probeResult as RegistrationProbeResult | null)?.budget?.kind,
    }),
  }))
  for (const { agent, readiness } of rows)
    presentation.log(
      `${agent.name.padEnd(7)} ${readiness} ${agent.billing.padEnd(13)} repo=${agent.caps.readsRepo ? 'y' : 'n'} mcp=${agent.caps.mcp ? 'y' : 'n'} schema=${agent.caps.schema ? 'y' : 'n'}  ${agent.notes}`,
    )
  presentation.log(
    `\nready: ${
      rows
        .filter((row) => row.readiness === 'ready')
        .map((row) => row.agent.name)
        .join(', ') || 'none'
    }`,
  )
}

export async function agentsPayload() {
  await ensureLocalHealth()
  return Object.values(AGENTS).map((agent) => {
    const caps = { ...agent.caps } as Record<string, boolean | number | null>
    delete caps.contextTokens
    return {
      name: agent.name,
      caps,
      model: agent.model,
      operatedBy: agent.operatedBy,
      contextTokens: Number.isFinite(agent.contextTokens) ? agent.contextTokens : null,
      maxPromptBytes: Number.isFinite(agent.maxPromptBytes) ? agent.maxPromptBytes : null,
      timeoutMs: agent.timeoutMs,
    }
  })
}
