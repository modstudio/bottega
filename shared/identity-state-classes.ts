// concern: identity-state-authority
/** Canonical state authority declarations consumed by production identity and inventory checks. */

export type IdentityAuthority = 'hosted' | 'synced' | 'machine'

export const IDENTITY_STATE_CLASSES = {
  question: {
    store: 'orchestrator',
    table: 'question',
    class: 'hosted',
    counterpart: 'question',
    reason: 'Questions awaiting or carrying rulings',
  },
  run: {
    store: 'orchestrator',
    table: 'run',
    class: 'synced',
    reason: 'Outbox source for runs',
  },
} as const
