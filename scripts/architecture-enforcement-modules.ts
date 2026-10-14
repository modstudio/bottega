// concern: architecture-manifest
/** Mechanical enforcement catalogue, resolution, and command module allowlists. */

export const enforcementModules = [
  {
    file: 'orchestrator/src/enforcement/enforcement-catalogue.ts',
    allowed: ['../../../shared/brand.ts'],
  },
  {
    file: 'orchestrator/src/enforcement/mechanical-check-declaration.ts',
    allowed: ['./enforcement-catalogue.ts'],
  },
  {
    file: 'orchestrator/src/enforcement/enforcement-resolution.ts',
    allowed: [
      '../../../shared/brand.ts',
      '../project/project-settings.ts',
      './enforcement-catalogue.ts',
      './mechanical-check-declaration.ts',
    ],
  },
  {
    file: 'orchestrator/src/enforcement/enforcement-commands.ts',
    allowed: ['../project/projects.ts', './enforcement-records.ts', './enforcement-resolution.ts'],
  },
  {
    file: 'orchestrator/src/enforcement/enforcement-records.ts',
    allowed: ['bun:sqlite', 'node:path', '../database/db.ts'],
  },
] as const
