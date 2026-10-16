import type { ImportBoundary } from './architecture-boundaries.ts'

export const recordIdentityBoundary: ImportBoundary = {
  name: 'postgres-identity-inventory-boundary',
  file: 'shared/record/identity-inventory.ts',
  allowed: [
    'drizzle-orm/pg-core',
    ...[
      'schema.ts',
      'schema-auth.ts',
      'schema-board.ts',
      'schema-config.ts',
      'schema-docs.ts',
      'schema-hub.ts',
      'schema-landing.ts',
      'schema-question.ts',
      'schema-release.ts',
      'schema-review.ts',
      'schema-run.ts',
      'schema-snapshots.ts',
      'schema-subjects.ts',
    ].map((file) => `shared/record/${file}`),
  ],
  typeOnlyAllowed: [],
  reason: 'Keep the hosted identity inventory limited to the checked-in Drizzle schema model.',
}
