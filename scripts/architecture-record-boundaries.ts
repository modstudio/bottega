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

export const recordReadBoundaries: ImportBoundary[] = [
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
