// concern: run identity value manifest
/** Run columns whose integer storage represents boolean values rather than row identity. */

import type { ManifestColumn } from './identity-inventory.ts'

const RUN_BOOLEAN_COLUMNS = [
  'run.probe',
  'run.no_failover',
  'run.automatic_failover',
  'run.agent_explicit',
  'run.transport_explicit',
  'run.carry_happened',
  'run.continued_with_findings',
  'run.mcp',
  'run.mcp_connected',
  'run.mcp_trust_granted',
  'run.keep_tree',
  'run.unreconciled',
  'run.work_preserved',
  'run.provisioning_entries_limited',
  'run.gate_requests_closed',
  'run.tests_claim_disagrees',
] as const

export const RUN_BOOLEAN_VALUES: readonly ManifestColumn[] = RUN_BOOLEAN_COLUMNS.map((column) => ({
  store: 'orchestrator',
  column,
  reason: 'boolean flag',
}))
