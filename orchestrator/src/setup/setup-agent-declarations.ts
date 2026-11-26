// concern: setup-agent-declarations
/** Decides how hosted agent declarations appear in setup. Pure: no store, process, or network. */

import { canonicalJson } from '../../../shared/canonical-json.ts'
import { type AgentMutation, BACKENDS, HARNESSES, TRANSPORTS } from '../agent/agent-registry.ts'
import type { RecordSpaceAgent } from '../record/record-space-agents.ts'
import { AGENT_BILLINGS } from '../transport/vendor-usage.ts'

export type DeclaredAgentRegistration = {
  name: string
  mutation: AgentMutation
}

export type LocalAgentDeclaration = RecordSpaceAgent & {
  enabled: boolean
  probedAt: string | null
}

export type MissingDeclarationDecision =
  | { kind: 'register'; registration: DeclaredAgentRegistration }
  | { kind: 'notice'; field: string }
  | { kind: 'present' }

function enumField(value: string | null, values: readonly string[]): boolean {
  return value !== null && values.includes(value)
}

function unregistrableField(declaration: RecordSpaceAgent): string | null {
  if (!enumField(declaration.harness, HARNESSES)) return 'harness'
  if (!enumField(declaration.backend, BACKENDS)) return 'backend'
  if (!enumField(declaration.transport, TRANSPORTS)) return 'transport'
  if (!enumField(declaration.billing, AGENT_BILLINGS)) return 'billing'
  const operatedBy = declaration.backend === 'vendor' ? 'vendor' : 'self'
  if (declaration.operatedBy !== operatedBy) return 'operatedBy'
  return null
}

function registration(declaration: RecordSpaceAgent): DeclaredAgentRegistration {
  return {
    name: declaration.name,
    mutation: {
      harness: declaration.harness as AgentMutation['harness'],
      backend: declaration.backend as AgentMutation['backend'],
      model: declaration.model,
      baseUrl: declaration.baseUrl,
      transport: declaration.transport as AgentMutation['transport'],
      provider: declaration.provider,
      apiKeySecret: declaration.apiKeySecret,
      requestSettings: declaration.requestSettings as AgentMutation['requestSettings'],
      jobs: declaration.jobs as AgentMutation['jobs'],
      preferredJobs: declaration.preferredJobs as AgentMutation['preferredJobs'],
      maxConcurrent: declaration.maxConcurrent,
      routeMetered: declaration.routeMetered,
      trainsOnInputs: declaration.trainsOnInputs,
      billing: declaration.billing as AgentMutation['billing'],
      enabled: declaration.enabled,
      ...(declaration.enabled ? {} : { reason: declaration.disabledReason! }),
    },
  }
}

/** Missing table: a valid absent declaration is offered; invalid and present rows are not. */
export function missingDeclaration(
  declaration: RecordSpaceAgent,
  local: LocalAgentDeclaration | undefined,
): MissingDeclarationDecision {
  const field = unregistrableField(declaration)
  return field
    ? { kind: 'notice', field }
    : local
      ? { kind: 'present' }
      : { kind: 'register', registration: registration(declaration) }
}

const DECLARED_FIELDS = [
  'harness',
  'backend',
  'model',
  'baseUrl',
  'transport',
  'provider',
  'apiKeySecret',
  'requestSettings',
  'jobs',
  'preferredJobs',
  'maxConcurrent',
  'routeMetered',
  'trainsOnInputs',
  'operatedBy',
  'billing',
] as const

/** Drift table: compare only declared configuration, never machine probe or enablement state. */
export function declarationDrift(
  declaration: RecordSpaceAgent,
  local: LocalAgentDeclaration | undefined,
): string[] {
  if (!local) return []
  return DECLARED_FIELDS.filter(
    (field) => canonicalJson(local[field]) !== canonicalJson(declaration[field]),
  )
}

type ProbeCandidates = {
  existingProbeNames: readonly string[]
  registrations: readonly DeclaredAgentRegistration[]
}

function probeNames(input: ProbeCandidates): string[] {
  return [
    ...input.existingProbeNames,
    ...input.registrations
      .filter((agent) => agent.mutation.enabled !== false)
      .map((agent) => agent.name),
  ].sort()
}

/** Probe-with-project table: unprobed local rows and accepted registrations are offered together. */
export function probesWithProject(
  input: ProbeCandidates & {
    projectPath: string | null
  },
): string[] {
  if (!input.projectPath) return []
  return probeNames(input)
}

/** Probe-without-project table: the same rows become individual notices. */
export function probesWithoutProject(input: ProbeCandidates): string[] {
  return probeNames(input)
}
