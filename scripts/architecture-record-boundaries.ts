import { dirname, normalize } from 'node:path'
import type { ImportBoundary } from './architecture-boundaries.ts'

const boundary = (
  name: string,
  file: string,
  allowed: string[],
  reason: string,
  typeOnlyAllowed: string[] = [],
): ImportBoundary => ({
  name,
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  typeOnlyAllowed: typeOnlyAllowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  reason,
})

export const recordReadBoundariesBeforePublish: ImportBoundary[] = [
  boundary(
    'record-doc-api-schemas-boundary',
    'orchestrator/src/record/record-api-doc-schemas.ts',
    ['zod'],
    'Keep hosted document payload validation independent of SQL and local execution.',
  ),
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
      '../mail/invitation-mailer.ts',
      '../mail/password-reset-mailer.ts',
      './record-invitation.ts',
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
      './record-canon-facts.ts',
    ],
    'Enforce the record-docs concern boundary.',
    ['../canon/canon-lint.ts'],
  ),
]

export const recordReadBoundariesAfterPublish: ImportBoundary[] = [
  boundary(
    'verdict-payload-boundary',
    'orchestrator/src/verdict/verdict-payload.ts',
    ['zod', '../review/review-vocabulary.ts', '../score/score.ts'],
    'Keep the verdict transport contract independent of persistence and delivery adapters.',
  ),
  boundary(
    'verdict-rules-boundary',
    'orchestrator/src/verdict/verdict-rules.ts',
    ['../failure/failure.ts', '../score/score.ts'],
    'Keep verdict policy pure and independent of local and hosted persistence adapters.',
  ),
  boundary(
    'record-verdicts-boundary',
    'orchestrator/src/record/record-verdicts.ts',
    ['bun', '../score/score.ts', '../verdict/verdict-payload.ts', '../verdict/verdict-rules.ts'],
    'Enforce the record-verdicts concern boundary.',
  ),
  boundary(
    'record-projects-boundary',
    'orchestrator/src/record/record-projects.ts',
    [
      'bun',
      '../../../shared/record/schema.ts',
      '../../../shared/record/tenant.ts',
      './record-project-columns.ts',
      './record-project-write.ts',
    ],
    'Keep hosted project record access isolated from other production modules.',
  ),
  boundary(
    'record-reviews-boundary',
    'orchestrator/src/record/record-reviews.ts',
    ['bun', '../../../shared/record/tenant.ts', './record-runs.ts'],
    'Keep hosted review record access limited to the hosted run record contract.',
  ),
  boundary(
    'record-runs-window-query-boundary',
    'orchestrator/src/record/record-runs-window-query.ts',
    ['zod'],
    'Keep the hosted run window query contract free of how the window is read.',
  ),
  boundary(
    'record-runs-boundary',
    'orchestrator/src/record/record-runs.ts',
    [
      'bun',
      '../../../shared/record/tenant.ts',
      '../failure/failure.ts',
      '../hook-tree/hook-tree.ts',
    ],
    'Enforce the record-runs concern boundary; the window counters share the local definitions of evidence and the hook-tree job.',
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
    'record-project-columns-boundary',
    'orchestrator/src/record/record-project-columns.ts',
    [],
    'Keep the hosted project column mapping pure and independent of SQL, HTTP, and stores.',
    ['../project/project-settings.ts'],
  ),
  boundary(
    'project-settings-boundary',
    'orchestrator/src/project/project-settings.ts',
    [],
    'Keep the project settings shape independent of stores, SQL, and HTTP.',
    [
      '../../../shared/trackers.ts',
      '../recipe/recipe.ts',
      '../workflow/autonomy.ts',
      '../worktree/worktree-provision.ts',
      '../worktree/worktree-template.ts',
      './project-injection.ts',
    ],
  ),
  boundary(
    'postgres-schema-config-boundary',
    'shared/record/schema-config.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
    'Enforce the hosted config schema concern boundary.',
  ),
  boundary(
    'postgres-schema-auth-boundary',
    'shared/record/schema-auth.ts',
    ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'],
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
