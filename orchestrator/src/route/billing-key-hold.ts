// concern: route
/** Decides machine-local routing holds shared by agents on one billing key. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type FailureKind, PROVIDER_UNSERVED } from '../failure/failure.ts'

export type BillingKeyAgent = {
  name: string
  baseUrl?: string | null
  apiKeySecret?: string | null
  provider?: string | null
}

type BillingKey = { secretName: string; baseUrl: string | null }
export type BillingKeyRun = {
  record_id: string
  number: number
  agent: string
  status: string
  failure_kind: string | null
  endpoint_key_source: 'agent' | 'project' | null
  credential_id: string | null
  finished_at: number
}
export type BillingKeyHold = BillingKey & {
  id: string
  agents: string[]
  failingRunNumber: number
}

const laterRun = (candidate: BillingKeyRun, current: BillingKeyRun | undefined) =>
  !current ||
  candidate.finished_at > current.finished_at ||
  (candidate.finished_at === current.finished_at && candidate.record_id > current.record_id)

/** The account identity that makes separate agent rows spend the same balance. */
function billingKeyForAgent(agent: BillingKeyAgent): BillingKey | null {
  const secretName = agent.apiKeySecret?.trim()
  if (!secretName) return null
  return { secretName, baseUrl: agent.baseUrl?.trim() || null }
}

const keyId = (key: BillingKey): string => JSON.stringify([key.secretName, key.baseUrl])

function successfulProviderAnswer(run: BillingKeyRun): boolean {
  return !(
    run.status === 'failed' &&
    run.failure_kind !== null &&
    PROVIDER_UNSERVED.has(run.failure_kind as FailureKind)
  )
}

function latestCredentialRunByAgent(runs: readonly BillingKeyRun[]): Map<string, BillingKeyRun> {
  const latestCredentialRunByAgent = new Map<string, BillingKeyRun>()
  for (const run of runs) {
    if (!run.credential_id) continue
    const current = latestCredentialRunByAgent.get(run.agent)
    if (laterRun(run, current)) latestCredentialRunByAgent.set(run.agent, run)
  }
  return latestCredentialRunByAgent
}

function credentialAgentsById(
  agents: readonly BillingKeyAgent[],
  latestByAgent: ReadonlyMap<string, BillingKeyRun>,
): Map<string, string[]> {
  const credentialAgents = new Map<string, string[]>()
  for (const agent of agents) {
    if (!agent.provider) continue
    const credentialId = latestByAgent.get(agent.name)?.credential_id
    if (!credentialId) continue
    credentialAgents.set(credentialId, [...(credentialAgents.get(credentialId) ?? []), agent.name])
  }
  return credentialAgents
}

function latestBillableRunByCredential(runs: readonly BillingKeyRun[]): Map<string, BillingKeyRun> {
  const latest = new Map<string, BillingKeyRun>()
  for (const run of runs) {
    if (!run.credential_id) continue
    if (run.failure_kind !== 'billing' && !successfulProviderAnswer(run)) continue
    const current = latest.get(run.credential_id)
    if (laterRun(run, current)) latest.set(run.credential_id, run)
  }
  return latest
}

function credentialBillingHolds(
  agents: readonly BillingKeyAgent[],
  runs: readonly BillingKeyRun[],
): BillingKeyHold[] {
  const credentialAgents = credentialAgentsById(agents, latestCredentialRunByAgent(runs))
  const latest = latestBillableRunByCredential(runs)
  return [...latest.entries()].flatMap(([credentialId, run]) => {
    const heldAgents = credentialAgents.get(credentialId) ?? []
    return run.failure_kind === 'billing' && heldAgents.length
      ? [
          {
            secretName: `credential ${credentialId}`,
            baseUrl: null,
            id: `credential:${credentialId}`,
            agents: heldAgents.sort(),
            failingRunNumber: run.number,
          },
        ]
      : []
  })
}

function legacyBillingHolds(
  agents: readonly BillingKeyAgent[],
  runs: readonly BillingKeyRun[],
): BillingKeyHold[] {
  const groups = new Map<string, { key: BillingKey; agents: string[] }>()
  const keyByAgent = new Map<string, string>()
  for (const agent of agents) {
    if (agent.provider) continue
    const key = billingKeyForAgent(agent)
    if (!key) continue
    const id = keyId(key)
    const group = groups.get(id) ?? { key, agents: [] }
    group.agents.push(agent.name)
    groups.set(id, group)
    keyByAgent.set(agent.name, id)
  }
  const latest = new Map<string, BillingKeyRun>()
  for (const run of runs) {
    if (run.credential_id) continue
    if ((run.endpoint_key_source ?? 'agent') === 'project') continue
    const id = keyByAgent.get(run.agent)
    if (!id || (run.failure_kind !== 'billing' && !successfulProviderAnswer(run))) continue
    const current = latest.get(id)
    if (laterRun(run, current)) latest.set(id, run)
  }

  return [...groups.entries()].flatMap(([id, group]) => {
    const run = latest.get(id)
    return run?.failure_kind === 'billing'
      ? [{ ...group.key, id, agents: group.agents.sort(), failingRunNumber: run.number }]
      : []
  })
}

/** Decide held accounts from current agent identities and terminal run history. */
export function decideBillingKeyHolds(
  agents: readonly BillingKeyAgent[],
  runs: readonly BillingKeyRun[],
): BillingKeyHold[] {
  return [...legacyBillingHolds(agents, runs), ...credentialBillingHolds(agents, runs)]
}

export function billingKeyHoldRefusal(hold: BillingKeyHold): string {
  return (
    `billing key ${hold.secretName} is held by billing failure on run ${hold.failingRunNumber}; ` +
    `restore the balance, then run '${PLATFORM_SLUG} agent probe <agent>' on any agent of that key`
  )
}

export function agentsOnBillingKey(
  agents: readonly BillingKeyAgent[],
  agentName: string,
): string[] {
  const target = agents.find((agent) => agent.name === agentName)
  const key = target && billingKeyForAgent(target)
  if (!key) return []
  const id = keyId(key)
  return agents
    .filter((agent) => {
      const candidate = billingKeyForAgent(agent)
      return candidate !== null && keyId(candidate) === id
    })
    .map((agent) => agent.name)
}
