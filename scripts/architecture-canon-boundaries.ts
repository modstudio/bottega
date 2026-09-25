import type { ImportBoundary } from './architecture-boundaries.ts'
import { canonLoadBoundarySpecs } from './architecture-canon-load-boundaries.ts'

const source = 'orchestrator/src/canon/'

const canonCommandBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-commands-boundary',
    file: `${source}canon-commands.ts`,
    allowed: [
      'node:fs',
      'node:path',
      'zod',
      `${source}canon.ts`,
      `${source}canon-audit.ts`,
      `${source}canon-files.ts`,
      `${source}canon-hydrate.ts`,
      `${source}canon-lint.ts`,
      `${source}canon-write-gate.ts`,
      `${source}canon-load-files.ts`,
      `${source}canon-load.ts`,
      `${source}canon-stored-rows.ts`,
      `${source}user-canon-commands.ts`,
      'orchestrator/src/agent/agent-registry.ts',
      'orchestrator/src/agent/worker-launch-env.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/doc/doc-write-allowed.ts',
      `${source}evals.ts`,
      'orchestrator/src/project/projects.ts',
      'orchestrator/src/workflow/workflow-tree-store.ts',
      'shared/ratchet.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep canon command adapters independent of runs, routing, transports, the CLI, and worktrees.',
  },
]

const canonAuditBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-audit-decision-boundary',
    file: `${source}canon-audit-decision.ts`,
    allowed: [],
    typeOnlyAllowed: ['shared/ratchet.ts'],
    reason:
      'Keep canon audit note identity and filing decisions pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'canon-audit-boundary',
    file: `${source}canon-audit.ts`,
    allowed: [
      `${source}canon-audit-decision.ts`,
      `${source}canon-files.ts`,
      `${source}canon-lint.ts`,
      'orchestrator/src/mcp/hub-notes.ts',
      'orchestrator/src/project/projects.ts',
    ],
    typeOnlyAllowed: ['shared/ratchet.ts'],
    reason:
      'Keep the repository canon audit dependent only on canon facts, the project register, and the published note boundary.',
  },
]

const userCanonBoundarySpecs: ImportBoundary[] = [
  {
    name: 'user-canon-import-boundary',
    file: 'orchestrator/src/doc/user-canon-import.ts',
    allowed: [
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/record-api-client.ts',
      'orchestrator/src/doc/doc-read-store.ts',
      'orchestrator/src/doc/doc-revision-store.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon batch mirroring independent of commands, filesystems, and unrelated stores.',
  },
  {
    name: 'user-canon-commands-boundary',
    file: `${source}user-canon-commands.ts`,
    allowed: [
      'shared/ratchet.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/doc/doc-write-allowed.ts',
      'orchestrator/src/doc/user-canon-import.ts',
      'orchestrator/src/project/projects.ts',
      `${source}canon-lint.ts`,
      `${source}canon-write-gate.ts`,
      `${source}user-canon-home.ts`,
      `${source}user-canon-home-files.ts`,
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon commands independent of runs, routing, transports, the CLI, and worktrees.',
  },
  {
    name: 'user-canon-home-boundary',
    file: `${source}user-canon-home.ts`,
    allowed: ['node:path', 'shared/brand.ts'],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon home mapping and hydration decisions pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'user-canon-home-files-boundary',
    file: `${source}user-canon-home-files.ts`,
    allowed: ['node:fs', 'node:path', `${source}user-canon-home.ts`],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon home file access independent of stores, commands, runs, routing, and transports.',
  },
]

const canonRemovalBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-removal-boundary',
    file: 'orchestrator/src/doc/canon-removal.ts',
    allowed: [
      `${source}canon-files.ts`,
      `${source}canon-hydrate.ts`,
      `${source}canon-write-gate.ts`,
      'orchestrator/src/project/projects.ts',
      'orchestrator/src/workflow/workflow-tree-store.ts',
      'orchestrator/src/doc/doc-read-store.ts',
      'orchestrator/src/doc/doc-write-allowed.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep canon removal preflight dependent on canon decisions and the services that gather its repository and workflow facts.',
  },
]

export const canonBoundarySpecs = [
  ...canonAuditBoundarySpecs,
  ...canonCommandBoundarySpecs,
  ...canonRemovalBoundarySpecs,
  ...userCanonBoundarySpecs,
  ...canonLoadBoundarySpecs,
]
