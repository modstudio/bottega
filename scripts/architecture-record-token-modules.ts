// concern: architecture-manifest
/** Small record token and password modules split from the record manifest at its file ceiling. */
export const recordTokenModules = [
  {
    file: 'orchestrator/src/record/record-session.ts',
    allowed: [
      'shared/record-remedies.ts',
      'shared/record-request-headers.ts',
      'shared/record-session.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/record-auth.ts',
      'orchestrator/src/record/record-pool.ts',
      'orchestrator/src/record/record-token.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/record-token.ts',
    allowed: [
      'bun:sqlite',
      'shared/record-session.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/record-token-key.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/record-token-key.ts',
    allowed: ['orchestrator/src/record/record-auth.ts'],
  },
  {
    file: 'orchestrator/src/record/record-password.ts',
    allowed: ['shared/brand.ts'],
  },
] as const
