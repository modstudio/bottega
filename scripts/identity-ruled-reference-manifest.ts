import type { RuledReference } from './identity-inventory.ts'

export const RULED_REFERENCES: readonly RuledReference[] = [
  ...(['hosted', 'orchestrator'] as const).map((store) => ({
    store,
    column: 'context_item.holder_id',
    reason: 'polymorphic reference selected by holder_kind',
    ruling:
      'DEV-2293 ruling q6165: context items use task, session, and cursor holders without a shared parent table',
  })),
  ...[
    'machine_key_claim_challenge.key_id',
    'secret_dek_wrap.recipient_key_id',
    'secret_dek_wrap.sender_key_id',
  ].map((column) => ({
    store: 'hosted' as const,
    column,
    reason:
      'fingerprint derived from a machine public key; enforced by composite foreign key to machine_public_key (space_id, key_id)',
    ruling:
      'operator rulings, board 01a1954f-2502-750d-abb8-6a41bb86dccc and DEV-2093: machine keys keep the fingerprint plus composite foreign keys',
  })),
]
