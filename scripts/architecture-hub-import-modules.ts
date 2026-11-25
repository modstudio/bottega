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
      '../../shared/install-root.ts',
      '../../shared/process-identity.ts',
      './editor-proposal.ts',
      './database/db.ts',
      './project/projects.ts',
      '../../shared/bounded-process.ts',
      './editor-judgment.ts',
      './registered-checkout.ts',
    ],
  },
  {
    file: 'orchestrator/src/editor-proposal.ts',
    allowed: ['node:fs', 'node:path'],
  },
  {
    file: 'orchestrator/src/editor-judgment.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/registered-checkout.ts',
    allowed: [
      'bun:sqlite',
      'node:fs',
      'node:path',
      '../../shared/brand.ts',
      './project/projects.ts',
    ],
  },
  {
    file: 'orchestrator/src/board-head-commands.ts',
    allowed: [
      'node:path',
      '../../scripts/hosted-local-board-head-check.ts',
      './database/db.ts',
      './editor-judgment.ts',
      './editor-proposal.ts',
      './registered-checkout.ts',
    ],
  },
  {
    file: 'orchestrator/src/commands/board-head.ts',
    allowed: ['commander', '../board-head-commands.ts', './support.ts'],
  },
  {
    file: 'orchestrator/src/commands/hub-import.ts',
    allowed: ['commander', '../hub-import-commands.ts', './support.ts'],
  },
] as const
