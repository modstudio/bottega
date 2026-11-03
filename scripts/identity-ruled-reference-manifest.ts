import type { RuledReference } from './identity-inventory.ts'

export const RULED_REFERENCES: readonly RuledReference[] = [
  ...['secret_dek_wrap.recipient_key_id', 'secret_dek_wrap.sender_key_id'].map((column) => ({
    store: 'hosted' as const,
    column,
    reason:
      'fingerprint derived from a machine public key; enforced by composite foreign key to machine_public_key (space_id, key_id)',
    ruling:
      'operator ruling, board 01a1954f-2502-750d-abb8-6a41bb86dccc: machine keys keep the fingerprint plus composite foreign keys',
  })),
]
