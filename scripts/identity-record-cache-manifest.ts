import type { ManifestColumn } from './identity-inventory.ts'

export const RECORD_CACHE_IDENTITIES: readonly ManifestColumn[] = [
  { store: 'orchestrator', column: 'doc.record_id', reason: 'document identity' },
  { store: 'orchestrator', column: 'doc.space_id', reason: 'hosted space identity' },
  { store: 'orchestrator', column: 'subject.id', reason: 'subject identity' },
  { store: 'orchestrator', column: 'subject.space_id', reason: 'hosted space identity' },
]
