import { dirname, normalize } from 'node:path'
import type { ImportBoundary } from './architecture-boundaries.ts'

const boundary = (
  name: string,
  file: string,
  allowed: string[],
  reason: string,
): ImportBoundary => ({
  name,
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  typeOnlyAllowed: [],
  reason,
})

export const recordReadBoundariesBeforePublish: ImportBoundary[] = [
  boundary(
    'record-auth-boundary',
    'orchestrator/src/record/record-auth.ts',
    [
      '@better-auth/drizzle-adapter/relations-v2',
      'better-auth',
      'better-auth/plugins',
      'bun',
      'drizzle-orm/bun-sql',
      '../../../shared/record/schema.ts',
      '../../../shared/record-remedies.ts',
      '../../../shared/record/schema-auth.ts',
      '../mail/password-reset-mailer.ts',
    ],
    'Enforce the record-auth concern boundary.',
  ),
  boundary(
    'record-config-boundary',
    'orchestrator/src/record/record-config.ts',
    [
      'bun',
      '../../../shared/machine-key-id.ts',
      '../../../shared/record/schema.ts',
      '../../../shared/record/tenant.ts',
    ],
    'Enforce the hosted config service concern boundary.',
  ),
  boundary(
    'record-docs-boundary',
    'orchestrator/src/record/record-docs.ts',
    [
      'bun',
      '../../../shared/record/schema.ts',
      '../../../shared/record/tenant.ts',
      '../doc/doc-write-allowed.ts',
    ],
    'Enforce the record-docs concern boundary.',
  ),
]

export const recordReadBoundariesAfterPublish: ImportBoundary[] = [
  boundary(
    'record-projects-boundary',
    'orchestrator/src/record/record-projects.ts',
    ['bun', '../../../shared/record/tenant.ts'],
    'Keep hosted project record access isolated from other production modules.',
  ),
  boundary(
    'record-reviews-boundary',
    'orchestrator/src/record/record-reviews.ts',
    ['bun', '../../../shared/record/tenant.ts', './record-runs.ts'],
    'Keep hosted review record access limited to the hosted run record contract.',
  ),
  boundary(
    'record-runs-boundary',
    'orchestrator/src/record/record-runs.ts',
    ['bun', '../../../shared/record/tenant.ts'],
    'Enforce the record-runs concern boundary.',
  ),
  boundary(
    'record-snapshots-boundary',
    'orchestrator/src/record/record-snapshots.ts',
    ['bun', '../../../shared/record/schema.ts', '../../../shared/record/tenant.ts'],
    'Enforce the hosted snapshot service concern boundary.',
  ),
]

export const recordSchemaBoundaries: ImportBoundary[] = [
  boundary(
    'postgres-schema-config-boundary',
    'shared/record/schema-config.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted config schema concern boundary.',
  ),
  boundary(
    'postgres-schema-auth-boundary',
    'shared/record/schema-auth.ts',
    ['drizzle-orm/pg-core', './schema.ts'],
    'Enforce the Better Auth schema concern boundary.',
  ),
  boundary(
    'postgres-schema-docs-boundary',
    'shared/record/schema-docs.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted doc schema concern boundary.',
  ),
  boundary(
    'postgres-schema-hub-boundary',
    'shared/record/schema-hub.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted hub evidence schema concern boundary.',
  ),
  boundary(
    'postgres-schema-landing-boundary',
    'shared/record/schema-landing.ts',
    ['drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted landing schema concern boundary.',
  ),
  boundary(
    'postgres-schema-review-boundary',
    'shared/record/schema-review.ts',
    ['drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted review schema concern boundary.',
  ),
  boundary(
    'postgres-schema-run-boundary',
    'shared/record/schema-run.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted run schema concern boundary.',
  ),
  boundary(
    'postgres-schema-snapshots-boundary',
    'shared/record/schema-snapshots.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted orchestrator snapshot schema concern boundary.',
  ),
]
