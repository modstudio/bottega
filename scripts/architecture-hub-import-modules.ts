// concern: architecture-manifest
/** Hub import write-time judge module allowlists. */

export const hubImportModules = [
  {
    file: 'orchestrator/src/hub-import-commands.ts',
    allowed: [
      'bun:sqlite',
      'node:crypto',
      'node:fs',
      'node:path',
      '../../shared/brand.ts',
      '../../shared/process-identity.ts',
      './database/db.ts',
      './project/projects.ts',
    ],
  },
  {
    file: 'orchestrator/src/commands/hub-import.ts',
    allowed: ['commander', '../hub-import-commands.ts', './support.ts'],
  },
] as const
