import type { ManifestColumn } from './identity-inventory.ts'

const integerValues: readonly ManifestColumn[] = [
  'prompt_bytes',
  'latency_ms',
  'vendor_tokens',
  'model_calls',
  'peak_call_tokens',
].map((column) => ({
  store: 'orchestrator',
  column: `routing_pool_run.${column}`,
  reason: 'measurement pulled from hosted routing evidence',
}))

const uuids: readonly ManifestColumn[] = [
  { column: 'routing_pool_run.record_id', reason: 'hosted run identity' },
  { column: 'routing_pool_run.space_id', reason: 'hosted space identity' },
  { column: 'routing_pool_lens.record_id', reason: 'locally owned pool lens identity' },
  { column: 'routing_pool_lens.run_record_id', reason: 'hosted run identity' },
].map(({ column, reason }) => ({ store: 'orchestrator', column, reason }))

export const ROUTING_POOL_IDENTITY = { integerValues, uuids }
