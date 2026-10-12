// concern: architecture-manifest
/** Mechanical enforcement catalogue, resolution, and command module allowlists. */

export const enforcementModules = [
  {
    file: 'orchestrator/src/enforcement/enforcement-catalogue.ts',
    allowed: ['../../../shared/brand.ts'],
  },
  {
    file: 'orchestrator/src/enforcement/enforcement-resolution.ts',
    allowed: ['../project/project-settings.ts', './enforcement-catalogue.ts'],
  },
  {
    file: 'orchestrator/src/enforcement/enforcement-commands.ts',
    allowed: ['../project/projects.ts', './enforcement-resolution.ts'],
  },
] as const
