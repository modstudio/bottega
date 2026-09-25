export const branchStoreModuleSpecs = [
  {
    name: 'branch-store-script-boundary',
    file: 'orchestrator/scripts/branch-store.ts',
    allowed: [
      'bun:sqlite',
      'node:crypto',
      'node:fs',
      'node:os',
      'node:path',
      '../../shared/brand.ts',
      '../src/database/database-location.ts',
      '../src/database/migrations.ts',
    ],
    reason: 'Keep branch-store preparation independent of project checks and pack compilation.',
  },
  {
    name: 'project-checks-script-boundary',
    file: 'orchestrator/scripts/check-projects.ts',
    allowed: ['bun:sqlite', 'node:url', '../src/database/migrations.ts', './branch-store.ts'],
    reason: 'Keep the project-checks runner a thin adapter over branch-store preparation.',
  },
] as const
