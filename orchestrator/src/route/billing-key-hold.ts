// concern: route
/** Decides machine-local routing holds shared by agents on one billing key. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type FailureKind, PROVIDER_UNSERVED } from '../failure/failure.ts'

export type BillingKeyAgent = {
  name: string
  baseUrl?: string | null
  apiKeySecret?: string | null
}

type BillingKey = { secretName: string; baseUrl: string | null }
export type BillingKeyRun = {
  record_id: string
  number: number
  agent: string
  status: string
  failure_kind: string | null
  endpoint_key_source: 'agent' | 'project' | null
  finished_at: number
}
export type BillingKeyHold = BillingKey & {
  id: string
  agents: string[]
  failingRunNumber: number
}

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

/** Decide held accounts from current agent identities and terminal run history. */
export function decideBillingKeyHolds(
  agents: readonly BillingKeyAgent[],
  runs: readonly BillingKeyRun[],
): BillingKeyHold[] {
  const groups = new Map<string, { key: BillingKey; agents: string[] }>()
  const keyByAgent = new Map<string, string>()
  for (const agent of agents) {
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
    if ((run.endpoint_key_source ?? 'agent') === 'project') continue
    const id = keyByAgent.get(run.agent)
    if (!id || (run.failure_kind !== 'billing' && !successfulProviderAnswer(run))) continue
    const current = latest.get(id)
    if (
      !current ||
      run.finished_at > current.finished_at ||
      (run.finished_at === current.finished_at && run.record_id > current.record_id)
    ) {
      latest.set(id, run)
    }
  }

  return [...groups.entries()].flatMap(([id, group]) => {
    const run = latest.get(id)
    return run?.failure_kind === 'billing'
      ? [{ ...group.key, id, agents: group.agents.sort(), failingRunNumber: run.number }]
      : []
  })
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
