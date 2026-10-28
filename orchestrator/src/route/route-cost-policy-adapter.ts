// concern: route cost policy adapter
/** Reads and resolves machine policy while leaving route evidence gathering to the router. */

import { readMachineValue } from '../../../shared/machine-config.ts'
import {
  parseRouteCostPolicy,
  type ResolvedCostPolicy,
  type RouteCostPolicy,
  resolveRouteCostPolicy,
} from './route-cost-policy.ts'

export type PreparedCostPolicy<T> = {
  configured: RouteCostPolicy
  resolved: ResolvedCostPolicy
  candidates: T[]
  priced: boolean
}

export function readRouteCostPolicy(): RouteCostPolicy {
  return parseRouteCostPolicy(readMachineValue('routing.cost_policy'))
}

export function findingsPolicyLens(findings: boolean, lens: string | undefined): string | null {
  return findings ? lens?.trim() || null : null
}

export function prepareCostPolicy<T extends { agent: string }, P>(input: {
  job: string
  lens: string | null
  writesRepo: boolean
  explain: boolean
  admitted: T[]
  pricedRows: () => Array<{ agent: string; costPerAccepted?: P }>
}): PreparedCostPolicy<T & { costPerAccepted?: P }> {
  const configured = readRouteCostPolicy()
  const resolved = resolveRouteCostPolicy(configured, input.job, input.lens, input.writesRepo)
  if (!configured.enabled && !input.explain)
    return { configured, resolved, candidates: input.admitted, priced: false }
  const prices = new Map(input.pricedRows().map((row) => [row.agent, row.costPerAccepted]))
  return {
    configured,
    resolved,
    priced: true,
    candidates: input.admitted.map((candidate) => ({
      ...candidate,
      costPerAccepted: prices.get(candidate.agent),
    })),
  }
}

export function enabledCostRule(prepared: PreparedCostPolicy<unknown>) {
  if (!prepared.configured.enabled) return undefined
  return { enabled: true, rate: prepared.resolved.rate, floor: prepared.resolved.floor }
}
