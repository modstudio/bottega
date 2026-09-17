import type { z } from 'zod'
import type { OrchBlockers, OrchStateSchema } from '../../shared/orch-contract.ts'

type RoutingState = z.infer<typeof OrchStateSchema>

export function routingViewData(
  state: RoutingState,
  blockers: OrchBlockers | null,
  blockerDays = blockers?.days ?? 14,
) {
  return {
    guide: state.guide,
    matrix: state.matrix,
    health: state.health,
    blockerDays,
    blockers: blockers?.blockers ?? null,
    agents: state.agents,
    spawns: state.spawns,
    byRepo: state.byRepo,
    totals: state.totals,
    unscored: state.unscored,
    stale: state.stale,
  }
}
