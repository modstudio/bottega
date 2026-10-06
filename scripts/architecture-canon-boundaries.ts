import type { ImportBoundary } from './architecture-boundaries.ts'
import { canonLoadBoundarySpecs } from './architecture-canon-load-boundaries.ts'

const source = 'orchestrator/src/canon/'

const canonEditGuardBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-edit-bash-boundary',
    file: `${source}canon-edit-bash.ts`,
    allowed: ['node:path'],
    typeOnlyAllowed: [],
    reason: 'Keep Bash tokenisation and write-target extraction pure.',
  },
  {
    name: 'canon-edit-transcript-boundary',
    file: `${source}canon-edit-transcript.ts`,
    allowed: [],
    typeOnlyAllowed: [],
    reason: 'Keep transcript role, pairing, and watermark-window parsing pure.',
  },
  {
    name: 'canon-edit-guard-boundary',
    file: `${source}canon-edit-guard.ts`,
    allowed: ['node:path', `${source}canon-edit-bash.ts`],
    typeOnlyAllowed: [`${source}canon-edit-transcript.ts`],
    reason:
      'Keep the pre-edit canon decision pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'canon-edit-hook-handler-boundary',
    file: `${source}canon-edit-hook-handler.ts`,
    allowed: [
      'node:path',
      `${source}canon-edit-bash.ts`,
      `${source}canon-edit-guard.ts`,
      `${source}canon-edit-transcript.ts`,
    ],
    typeOnlyAllowed: [],
    reason: 'Keep hook sequencing in-process and independent of concrete I/O adapters.',
  },
  {
    name: 'canon-edit-hook-ports-boundary',
    file: `${source}canon-edit-hook-ports.ts`,
    allowed: [
      'node:fs',
      'node:path',
      'shared/state-directory.ts',
      `${source}canon-lint.ts`,
      'orchestrator/src/database/db.ts',
      'orchestrator/src/project/projects.ts',
    ],
    typeOnlyAllowed: [
      `${source}canon-edit-hook-handler.ts`,
      `${source}canon-edit-guard.ts`,
      `${source}canon-edit-transcript.ts`,
    ],
    reason: 'Keep concrete hook facts limited to canon files, state, and the project register.',
  },
  {
    name: 'canon-edit-guard-hook-boundary',
    file: 'orchestrator/hooks/canon-edit-guard.ts',
    allowed: [
      `${source}canon-edit-hook-handler.ts`,
      `${source}canon-edit-hook-ports.ts`,
      `${source}canon-edit-guard.ts`,
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep the hook as the thin adapter from harness, tree, register, and state facts to the pure canon decision.',
  },
]

const canonCommandBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-commands-boundary',
    file: `${source}canon-commands.ts`,
    allowed: [
      'node:fs',
      'node:path',
      'zod',
      `${source}canon.ts`,
      `${source}canon-apply.ts`,
      `${source}canon-audit.ts`,
      `${source}canon-files.ts`,
      `${source}canon-hydrate.ts`,
      `${source}canon-import-policy.ts`,
      `${source}canon-lint.ts`,
      `${source}canon-write-gate.ts`,
      `${source}canon-load-files.ts`,
      `${source}canon-load.ts`,
      `${source}canon-stored-rows.ts`,
      `${source}canon-mirror.ts`,
      `${source}user-canon-commands.ts`,
      'orchestrator/src/agent/agent-registry.ts',
      'orchestrator/src/agent/worker-launch-env.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/doc/doc-write-allowed.ts',
      'orchestrator/src/doc/canon-import.ts',
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

const canonMirrorBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-apply-boundary',
    file: `${source}canon-apply.ts`,
    allowed: ['node:fs', 'node:path'],
    typeOnlyAllowed: [`${source}canon-hydrate.ts`],
    reason: 'Keep hydration file writes independent of stores, commands, runs, and transports.',
  },
  {
    name: 'canon-mirror-boundary',
    file: `${source}canon-mirror.ts`,
    allowed: [
      'node:crypto',
      'node:fs',
      'node:os',
      'node:path',
      `${source}canon-apply.ts`,
      'shared/secret-shaped.ts',
      `${source}canon-files.ts`,
      `${source}canon-hydrate.ts`,
      `${source}canon-lint.ts`,
      `${source}canon-stored-rows.ts`,
      'orchestrator/src/close/close-out.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/git/git-environment.ts',
      'orchestrator/src/mcp/hub-notes.ts',
      'orchestrator/src/project/project-lock.ts',
      'orchestrator/src/project/projects.ts',
      'orchestrator/src/pull-request/pr-admission.ts',
      'orchestrator/src/resources/resource-claims.ts',
      'orchestrator/src/run/run-lease.ts',
      'orchestrator/src/run/synthetic-lifecycle-job.ts',
      'orchestrator/src/workflow/autonomy-scopes.ts',
      'orchestrator/src/workflow/workflow-tree-store.ts',
      'orchestrator/src/worktree/worktree-create.ts',
      'orchestrator/src/worktree/worktree-attribution.ts',
    ],
    typeOnlyAllowed: ['bun:sqlite'],
    reason:
      'Keep scheduled canon publication limited to hydration, registered lifecycle, pull-request admission, and its Git/GitHub port.',
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
    name: 'canon-import-policy-boundary',
    file: `${source}canon-import-policy.ts`,
    allowed: [
      `${source}canon-hydrate.ts`,
      `${source}canon-write-gate.ts`,
      `${source}user-canon-home.ts`,
    ],
    typeOnlyAllowed: [`${source}canon-lint.ts`],
    reason: 'Keep canon import policy pure and independent of stores, transports, and commands.',
  },
  {
    name: 'canon-import-boundary',
    file: 'orchestrator/src/doc/canon-import.ts',
    allowed: [
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/record-api-client.ts',
      'orchestrator/src/record/record-write-authority.ts',
      'shared/record/schema.ts',
      'orchestrator/src/worker-store-write.ts',
      'orchestrator/src/doc/doc-read-store.ts',
      'orchestrator/src/doc/doc-revision-store.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep canon batch mirroring independent of commands, filesystems, and unrelated stores.',
  },
  {
    name: 'user-canon-commands-boundary',
    file: `${source}user-canon-commands.ts`,
    allowed: [
      'shared/ratchet.ts',
      'shared/state-directory.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/doc/doc-write-allowed.ts',
      'orchestrator/src/doc/canon-import.ts',
      `${source}canon-import-policy.ts`,
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
    allowed: [
      'node:fs',
      'node:path',
      'orchestrator/src/settings/settings-write.ts',
      `${source}user-canon-home.ts`,
    ],
    typeOnlyAllowed: ['shared/state-directory.ts'],
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
  ...canonEditGuardBoundarySpecs,
  ...canonAuditBoundarySpecs,
  ...canonCommandBoundarySpecs,
  ...canonMirrorBoundarySpecs,
  ...canonRemovalBoundarySpecs,
  ...userCanonBoundarySpecs,
  ...canonLoadBoundarySpecs,
]
