// concern: route subscription pacing adapter
/** Gathers quota facts once and decides every subscription pacing hold for a routing pass. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Agent } from '../agent/agents.ts'
import { harnessCollectsQuotaReadings } from '../transport/codex-quota.ts'
import {
  decideSubscriptionPacing,
  type SubscriptionPacingHold,
  subscriptionJobIsUnpaced,
} from './subscription-pacing.ts'
import { subscriptionPacingFacts } from './subscription-pacing-store.ts'

function withNoDataRemedy(agentName: string, hold: SubscriptionPacingHold): SubscriptionPacingHold {
  if (hold.estimatePercent !== null) return hold
  return {
    ...hold,
    refusal: `${hold.refusal}; record a reading with ${PLATFORM_SLUG} agent probe ${agentName}`,
  }
}

export function subscriptionPacingHolds(
  database: Database,
  agents: readonly Agent[],
  input: { now?: number; writesRepo: boolean; highStakesLens: boolean },
): Map<string, SubscriptionPacingHold> {
  if (subscriptionJobIsUnpaced(input.writesRepo)) return new Map()
  const paced = agents.filter(
    (agent) => agent.billing === 'subscription' && harnessCollectsQuotaReadings(agent.harness),
  )
  const now = input.now ?? Date.now()
  const facts = subscriptionPacingFacts(
    database,
    paced.map((agent) => agent.harness!),
    now,
  )
  return new Map(
    paced.flatMap((agent) => {
      const harnessFacts = facts.get(agent.harness!)
      if (!harnessFacts) return []
      const hold = decideSubscriptionPacing({ now, ...harnessFacts, ...input })
      return hold ? [[agent.name, withNoDataRemedy(agent.name, hold)] as const] : []
    }),
  )
}
