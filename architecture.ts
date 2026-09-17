import { dirname, join, normalize } from 'node:path'
import { importBoundaries } from './architecture-boundaries.ts'
import { CONCERNS } from './shared/brand.ts'

type ConcernManifest = {
  roots: typeof CONCERNS
  shared: { root: 'shared'; reason: string }
  exceptions: Array<{
    from: string
    to: string
    dependencyTypes: string[]
    reason: string
  }>
}

export type ArchitectureModule = { file: string; allowed: string[] }
type ArchitectureInversion = { from: string; to: string }
type ArchitectureCycle = { cycle: string[]; reason: string }

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

const concerns: ConcernManifest = {
  roots: CONCERNS,
  shared: {
    root: 'shared',
    reason: 'Shared code may depend on no platform concern.',
  },
  exceptions: [
    {
      from: 'hub/web',
      to: 'hub/src/trpc/router.ts',
      dependencyTypes: ['type-only'],
      reason: 'The web client imports only the hub router type across the web boundary.',
    },
  ],
}

/**
 * The hub dashboard's component layers, lowest first. A folder under
 * `hub/web/src/ui/` belongs to exactly one layer and may import only its own
 * layer or a lower one. `behavior` holds hooks and pure helpers with no markup;
 * `primitives` are single controls; `overlays` open above the page; `patterns`
 * compose controls into one reusable piece; `layout` arranges a screen.
 */
const uiLayers: { name: string; folders: string[] }[] = [
  { name: 'behavior', folders: ['state', 'dom', 'text'] },
  {
    name: 'primitives',
    folders: [
      'badge',
      'identifier',
      'button',
      'field',
      'checkbox',
      'switch',
      'spinner',
      'kbd',
      'separator',
    ],
  },
  {
    name: 'overlays',
    folders: ['popover', 'tooltip', 'menu', 'listbox', 'dialog', 'sheet', 'toast'],
  },
  {
    name: 'patterns',
    folders: [
      'tabs',
      'segmented',
      'empty-state',
      'stat',
      'table',
      'page-header',
      'project-mark',
      'pagination',
      'form-layout',
    ],
  },
  { name: 'layout', folders: ['shell', 'table-card', 'toolbar-band', 'companion'] },
]

const uiFolders = (folders: string[]) => `^hub/web/src/ui/(?:${folders.join('|')})/`

export const modules: ArchitectureModule[] = [
  module('orchestrator/src/artifact-paths.ts', ['node:path']),
  module('orchestrator/src/branch/branch-landing-record.ts', ['./branch-state.ts']),
  module('orchestrator/src/branch/branch-state.ts', ['../merged-pull-request.ts']),
  module('orchestrator/src/merged-pull-request.ts', ['./git-environment.ts', './projects.ts']),
  module('orchestrator/src/other-branch-state.ts', [
    './branch/branch-state.ts',
    './merged-pull-request.ts',
  ]),
  module('orchestrator/src/branch/branch-settlement.ts', [
    '../db.ts',
    '../evidence-query.ts',
    '../resource-claims.ts',
  ]),
  module('orchestrator/src/branch/branches.ts', [
    './branch-landing-record.ts',
    './branch-state.ts',
    './branch-settlement.ts',
    '../db.ts',
    '../git-environment.ts',
    '../merged-pull-request.ts',
    '../other-branch-state.ts',
    '../projects.ts',
    '../task-branch.ts',
  ]),
  module('orchestrator/src/agent-probe.ts', [
    './agent-registry.ts',
    './agents.ts',
    './capabilities.ts',
    './db.ts',
    './jobs.ts',
    './local-host.ts',
    './mcp-probe.ts',
    './transport/transport.ts',
  ]),
  module('orchestrator/src/agent-registry.ts', ['./agents.ts', './capabilities.ts', './db.ts']),
  module('orchestrator/src/calibration-port.ts', []),
  module('orchestrator/src/capabilities.ts', []),
  module('orchestrator/src/codex-mcp-scope.ts', ['./database-location.ts', './mcp-probe.ts']),
  module('orchestrator/src/codex-schema.ts', []),
  module('orchestrator/src/env-file.ts', []),
  module('orchestrator/src/hook-tree.ts', []),
  module('orchestrator/src/keep-tree-hold.ts', []),
  module('orchestrator/src/local-host.ts', [
    '../../shared/state-directory.ts',
    './agent-registry.ts',
    './agents.ts',
    './db.ts',
  ]),
  module('orchestrator/src/mcp-doc-write.ts', []),
  module('orchestrator/src/monitor/monitor.ts', [
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../canon.ts',
    '../db.ts',
    '../docker-resources.ts',
    '../git-locks.ts',
    '../keep-tree-hold.ts',
    '../mcp.ts',
    './monitor-conditions.ts',
    './monitor-notices.ts',
    './monitor-types.ts',
    '../process-liveness.ts',
    '../project-lock.ts',
    '../projects.ts',
    '../reclaim/reclaim.ts',
    '../grok-trust.ts',
    '../idle-kill.ts',
    '../resource-ownership.ts',
    '../review-vocabulary.ts',
    '../run-artifacts.ts',
    '../worktree-attribution.ts',
  ]),
  module('orchestrator/src/monitor/monitor-conditions.ts', [
    'node:fs',
    'node:path',
    '../db.ts',
    '../events.ts',
    '../evidence-query.ts',
    '../git-environment.ts',
    '../hook-tree.ts',
    '../idle-kill.ts',
    './monitor-types.ts',
    '../process-liveness.ts',
    '../project-lock.ts',
    '../projects.ts',
    '../resource-claims.ts',
    '../resource-inventory.ts',
    '../run-alive.ts',
    '../run-lease.ts',
  ]),
  module('orchestrator/src/monitor/monitor-notices.ts', [
    '../db.ts',
    './monitor-conditions.ts',
    './monitor-types.ts',
    '../review-vocabulary.ts',
  ]),
  module('orchestrator/src/monitor/monitor-types.ts', ['../review-vocabulary.ts']),
  module('orchestrator/src/postgres/postgres-migrate.ts', []),
  module('shared/gate-timing-directory.ts', ['./brand.ts', './state-directory.ts']),
  module('shared/state-directory.ts', ['./brand.ts']),
  module('shared/record/schema.ts', ['../brand.ts']),
  module('shared/record-session.ts', ['./brand.ts']),
  module('orchestrator/src/record-command.ts', [
    './postgres/postgres-migrate.ts',
    './record-doctor.ts',
    './record-space.ts',
  ]),
  module('orchestrator/src/record-doctor.ts', [
    './postgres/postgres-migrate.ts',
    '../../shared/record/schema.ts',
    './record-auth.ts',
    './record-session.ts',
    './record-sync.ts',
  ]),
  module('orchestrator/src/record-session.ts', [
    '../../shared/record-session.ts',
    './db.ts',
    './record-auth.ts',
  ]),
  module('orchestrator/src/record-space.ts', [
    '../../shared/record/schema.ts',
    './record-auth.ts',
    './record-session.ts',
  ]),
  module('orchestrator/src/score-outbox.ts', ['../../shared/record/schema.ts']),
  module('orchestrator/src/project-lock.ts', [
    './db.ts',
    './git-environment.ts',
    '../../shared/process-identity.ts',
  ]),
  module('orchestrator/src/project-injection.ts', ['zod', '../../shared/trackers.ts']),
  module('orchestrator/src/ref-guard.ts', [
    './db.ts',
    './process-liveness.ts',
    './worktree-attribution.ts',
    './git-environment.ts',
  ]),
  module('orchestrator/src/reclaim/reclaim-residue-policy.ts', []),
  module('orchestrator/src/reclaim/reclaim-worktree-dirty.ts', []),
  module('orchestrator/src/reclaim/reclaim-residue.ts', [
    'node:fs',
    'node:path',
    '../agent-registry.ts',
    '../db.ts',
    '../git-environment.ts',
    '../grok-trust.ts',
    '../idle-kill.ts',
    '../process-liveness.ts',
    '../project-lock.ts',
    '../projects.ts',
    './reclaim-residue-policy.ts',
    '../run-artifacts.ts',
    '../run-process.ts',
    '../run-alive.ts',
    '../run-lease.ts',
  ]),
  module('orchestrator/src/resource-claims.ts', ['./hook-tree.ts']),
  module('orchestrator/src/resume-tree.ts', []),
  module('orchestrator/src/review-calibration.ts', [
    './db.ts',
    './review-vocabulary.ts',
    './statistics.ts',
    './review-evidence-sql.ts',
    './review-triage.ts',
  ]),
  module('orchestrator/src/review-coverage.ts', [
    './db.ts',
    './change-identity.ts',
    './review-evidence-sql.ts',
    './review-pins.ts',
    './review-types.ts',
  ]),
  module('orchestrator/src/review-coverage-match.ts', []),
  module('orchestrator/src/review-evidence-sql.ts', ['./evidence-query.ts']),
  module('orchestrator/src/review-pins.ts', [
    './db.ts',
    './git-environment.ts',
    './change-identity.ts',
    './review-types.ts',
  ]),
  module('orchestrator/src/review-triage.ts', [
    './db.ts',
    './review-vocabulary.ts',
    './contract.ts',
    './review.ts',
    './review-outbox.ts',
  ]),
  module('orchestrator/src/review-types.ts', ['./review-vocabulary.ts', './change-identity.ts']),
  module('orchestrator/src/run-alive.ts', []),
  module('orchestrator/src/run-claim.ts', [
    './agents.ts',
    './codex-schema.ts',
    './canon.ts',
    './checkout-identity.ts',
    './contract.ts',
    './db.ts',
    './dispatch-preflight.ts',
    './events.ts',
    './failover.ts',
    './git-environment.ts',
    './grok-trust.ts',
    './keep-tree-hold.ts',
    './mcp-preflight.ts',
    './mcp-probe.ts',
    './project-lock.ts',
    './projects.ts',
    './prompt-retarget.ts',
    '../../shared/record/schema.ts',
    './resource-claims.ts',
    './resource-ownership.ts',
    './review-target.ts',
    './run-artifacts.ts',
    './run-process.ts',
    './resume-tree.ts',
    './sandbox.ts',
    './task-branch.ts',
    './worktree.ts',
    './worktree-caller.ts',
    './worktree-mcp.ts',
    './worktree-preflight.ts',
    './worktree-remove.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/run-close.ts', [
    './close-out.ts',
    './contract.ts',
    './db.ts',
    './failover.ts',
    './failure.ts',
    './jobs.ts',
    './keep-tree-hold.ts',
    './mcp-preflight.ts',
    './projects.ts',
    './review-calibration.ts',
    './route.ts',
    './run-process.ts',
    './run-types.ts',
    './transport/transport.ts',
    './worktree-remove.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/run-lease.ts', [
    './database-location.ts',
    './project-lock.ts',
    './run-alive.ts',
  ]),
  module('orchestrator/src/run-live.ts', [
    './agents.ts',
    './ask.ts',
    './checkpoint.ts',
    './codex-mcp-scope.ts',
    './confinement.ts',
    './contract.ts',
    './db.ts',
    './events.ts',
    './failure.ts',
    './git-environment.ts',
    './idle-kill.ts',
    './jobs.ts',
    './mailbox/mailbox.ts',
    './outcome.ts',
    './project-lock.ts',
    './run-process.ts',
    './sandbox.ts',
    './transport/transport.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/run-terminal.ts', [
    './ask.ts',
    './checkpoint.ts',
    './confinement.ts',
    './contract.ts',
    './db.ts',
    './evidence.ts',
    './failure.ts',
    './idle-kill.ts',
    './jobs.ts',
    './machine-identity.ts',
    './mcp-preflight.ts',
    './outcome.ts',
    './projects.ts',
    './resource-ownership.ts',
    './review.ts',
    './run-artifacts.ts',
    './run-liveness.ts',
    './run-outbox.ts',
    './run-process.ts',
    './sandbox.ts',
    './worktree-remove.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/run-types.ts', [
    './contract.ts',
    './worktree-remove.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/runtime-registration.ts', [
    './standard-calibration.ts',
    './store-hooks.ts',
    './standard-transports.ts',
  ]),
  module('orchestrator/src/sandbox.ts', ['./db.ts', './mcp-probe.ts', './projects.ts']),
  module('orchestrator/src/standard-calibration.ts', [
    './calibration-port.ts',
    './review-calibration.ts',
  ]),
  module('orchestrator/src/standard-transports.ts', [
    './transport/transport-acp.ts',
    './transport/transport-cli.ts',
  ]),
  module('orchestrator/src/statistics.ts', []),
  module('orchestrator/src/tree-commands.ts', ['./tree.ts']),
  module('orchestrator/src/tree.ts', [
    'node:crypto',
    'node:fs',
    'node:path',
    './close-out.ts',
    './db.ts',
    './git-environment.ts',
    './hook-tree.ts',
    './projects.ts',
    './resource-claims.ts',
    './run-lease.ts',
    './tracked-recipe.ts',
    './worktree-create.ts',
    './worktree-lifecycle.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree.ts', ['../step-catalogue.ts', './workflows.ts']),
  module('orchestrator/src/workflow/workflow-tree-files.ts', [
    'node:fs',
    'node:path',
    './workflow-tree.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-store.ts', [
    'bun:sqlite',
    'node:util',
    '../db.ts',
    '../step-catalogue.ts',
    './workflow-tree.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/worktree-caller.ts', [
    './projects.ts',
    './git-environment.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree-create.ts', [
    './db.ts',
    './projects.ts',
    './recipe/recipe.ts',
    './tracked-recipe.ts',
    './worktree-template.ts',
    './worktree-attribution.ts',
    './git-environment.ts',
    './project-lock.ts',
    './worktree-remove.ts',
    './worktree-caller.ts',
    './worktree-tool.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree-preflight.ts', [
    './projects.ts',
    './worktree-template.ts',
    './git-environment.ts',
  ]),
  module('orchestrator/src/worktree-readonly.ts', [
    './projects.ts',
    './readonly-provision.ts',
    './worktree-template.ts',
    './git-environment.ts',
    './worktree-remove.ts',
    './worktree-create.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree-remove.ts', [
    './db.ts',
    './projects.ts',
    './recipe/recipe.ts',
    './tracked-recipe.ts',
    './worktree-attribution.ts',
    './git-environment.ts',
    './ref-guard.ts',
    './resource-claims.ts',
    './worktree-tool.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree-tool.ts', ['./worktree-template.ts', './git-environment.ts']),
  module('orchestrator/src/worktree-types.ts', []),
  module('hub/src/fixture-question-reclaim.ts', ['./db.ts', './orch.ts', './reconcile.ts']),
  module('hub/src/serve-lifecycle.ts', [
    '../../shared/process-identity.ts',
    '../../shared/state-directory.ts',
  ]),
]

export const inversions: ArchitectureInversion[] = [
  { from: 'orchestrator/src/jobs.ts', to: 'orchestrator/src/agents.ts' },
  { from: 'orchestrator/src/route.ts', to: 'orchestrator/src/review.ts' },
  { from: 'orchestrator/src/review.ts', to: 'orchestrator/src/route.ts' },
  { from: 'orchestrator/src/transport/transport.ts', to: 'orchestrator/src/agents.ts' },
  {
    from: 'orchestrator/src/transport/transport.ts',
    to: 'orchestrator/src/transport/transport-cli.ts',
  },
  {
    from: 'orchestrator/src/transport/transport.ts',
    to: 'orchestrator/src/transport/transport-acp.ts',
  },
]

const allowedCycles: ArchitectureCycle[] = [
  {
    cycle: [
      'orchestrator/src/canon.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/canon.ts',
    ],
    reason: 'Pre-existing operator-doc/canon compilation cycle outside the specified inversions.',
  },
]

export const exactArchitecturePath = (path: string) =>
  `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`

function architectureDependencyPath(target: string) {
  if (target.startsWith('node:')) return exactArchitecturePath(target.slice('node:'.length))
  if (target === 'bun') return '(^|/)node_modules/\\.bun/[^/]+/node_modules/@types/bun/'
  if (target.includes(':')) return exactArchitecturePath(target)
  if (CONCERNS.some((root) => target.startsWith(`${root}/`)) || target.startsWith('shared/')) {
    return exactArchitecturePath(target)
  }
  const [first, second, ...remainder] = target.split('/')
  const packageName = first?.startsWith('@') ? `${first}/${second}` : first!
  const packagePath = first?.startsWith('@') ? remainder : [second, ...remainder].filter(Boolean)
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedPath = packagePath.map((part) => part!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const installed = `(^|/)node_modules/\\.bun/[^/]+/node_modules/${escapedPackage}/`
  const unresolved = exactArchitecturePath(target)
  return escapedPath.length
    ? `${installed}${escapedPath.join('/')}(?:/|$)|${unresolved}`
    : installed
}

type ArchitectureRule = {
  name: string
  severity: 'error'
  comment?: string
  from: { path: string; pathNot?: string[] }
  to: {
    path?: string
    pathNot?: string[]
    dependencyTypes?: string[]
    dependencyTypesNot?: string[]
    circular?: boolean
    reachable?: boolean
  }
}

export function architectureRules() {
  const exception = concerns.exceptions[0]!
  const cycleFiles = [...new Set(allowedCycles.flatMap(({ cycle }) => cycle.slice(0, -1)))]
  const forbidden: ArchitectureRule[] = [
    {
      name: 'concern-isolation',
      severity: 'error',
      from: { path: `^(${concerns.roots.join('|')})/` },
      to: { path: `^(?!$1/|shared/)(${concerns.roots.join('|')})/` },
    },
    {
      name: 'shared-is-independent',
      severity: 'error',
      comment: concerns.shared.reason,
      from: { path: '^shared/' },
      to: { path: `^(${concerns.roots.join('|')})/` },
    },
    {
      name: 'hub-web-imports-only-router-type',
      severity: 'error',
      comment: exception.reason,
      from: { path: `^${exception.from}/` },
      to: {
        path: '^hub/(?!web/)',
        pathNot: [exactArchitecturePath(exception.to)],
      },
    },
    {
      name: 'hub-web-router-is-type-only',
      severity: 'error',
      comment: exception.reason,
      from: { path: `^${exception.from}/` },
      to: {
        path: exactArchitecturePath(exception.to),
        dependencyTypesNot: exception.dependencyTypes,
      },
    },
    ...modules.map((entry) => ({
      name: `module-${entry.file.replace(/[^a-z0-9]+/gi, '-')}`,
      severity: 'error' as const,
      from: { path: exactArchitecturePath(entry.file) },
      to: {
        dependencyTypes: ['local'],
        pathNot: entry.allowed.map(exactArchitecturePath),
      },
    })),
    ...importBoundaries.map((entry) => ({
      name: `import-${entry.name}`,
      severity: 'error' as const,
      comment: entry.reason,
      from: { path: exactArchitecturePath(entry.file) },
      to: {
        pathNot: [...entry.allowed, ...entry.typeOnlyAllowed].map(architectureDependencyPath),
      },
    })),
    ...importBoundaries.flatMap((entry) =>
      entry.typeOnlyAllowed.map((target) => ({
        name: `import-${entry.name}-${target.replace(/[^a-z0-9]+/gi, '-')}-is-type-only`,
        severity: 'error' as const,
        comment: entry.reason,
        from: { path: exactArchitecturePath(entry.file) },
        to: {
          path: architectureDependencyPath(target),
          dependencyTypesNot: ['type-only'],
        },
      })),
    ),
    {
      name: 'hub-web-ui-is-a-leaf',
      severity: 'error',
      comment:
        'The component library knows nothing of the app: ui/ imports only ui/, React and icons, through relative paths.',
      from: { path: '^hub/web/src/ui/' },
      to: { path: '^(?:hub/web/src/(?!ui/)|@/)' },
    },
    {
      name: 'hub-web-ui-folder-has-a-layer',
      severity: 'error',
      comment: 'Every ui/ folder is declared in uiLayers in architecture.ts.',
      from: {
        path: '^hub/web/src/ui/',
        pathNot: uiFolders(uiLayers.flatMap((layer) => layer.folders)),
      },
      to: {},
    },
    ...uiLayers.slice(0, -1).map((layer, index) => ({
      name: `hub-web-ui-${layer.name}-imports-no-higher-layer`,
      severity: 'error' as const,
      comment: `A ${layer.name} folder may import only its own or a lower ui layer.`,
      from: { path: uiFolders(layer.folders) },
      to: { path: uiFolders(uiLayers.slice(index + 1).flatMap((higher) => higher.folders)) },
    })),
    {
      name: 'import-cli-boundary',
      severity: 'error',
      comment:
        'Keep the bought CLI grammar thin: program.ts and commands/ adapt argv to concern modules and never dispatch through the run nucleus.',
      from: { path: '^orchestrator/src/(?:program\\.ts|commands/)' },
      to: { path: exactArchitecturePath('orchestrator/src/run.ts') },
    },
    {
      name: 'import-record-api-server-transitive-boundary',
      severity: 'error',
      comment: 'Enforce the record-api-server concern boundary.',
      from: { path: exactArchitecturePath('orchestrator/src/record-api-server.ts') },
      to: {
        path: '^(?:orchestrator/src/(?:database-location|db)\\.ts|bun:sqlite)$',
        reachable: true,
      },
    },
    ...inversions.map((entry) => ({
      name: `inversion-${entry.from.replace(/[^a-z0-9]+/gi, '-')}-${entry.to.replace(/[^a-z0-9]+/gi, '-')}`,
      severity: 'error' as const,
      from: { path: exactArchitecturePath(entry.from) },
      to: { path: exactArchitecturePath(entry.to) },
    })),
    {
      name: 'no-new-orchestrator-cycles',
      severity: 'error',
      from: {
        path: '^orchestrator/src/',
        pathNot: cycleFiles.map(exactArchitecturePath),
      },
      to: { path: '^orchestrator/src/', circular: true },
    },
    ...allowedCycles.flatMap((entry) =>
      entry.cycle.slice(0, -1).map((from, index) => ({
        name: `cycle-exception-${index}-${from.replace(/[^a-z0-9]+/gi, '-')}`,
        severity: 'error' as const,
        comment: entry.reason,
        from: { path: exactArchitecturePath(from) },
        to: {
          path: '^orchestrator/src/',
          pathNot: [exactArchitecturePath(entry.cycle[index + 1]!)],
          circular: true,
        },
      })),
    ),
  ]
  return { forbidden }
}

export function dependencyCruiserConfig() {
  return {
    ...architectureRules(),
    options: {
      tsConfig: { fileName: join(import.meta.dir, 'orchestrator/tsconfig.json') },
      tsPreCompilationDeps: true,
      doNotFollow: { path: 'node_modules' },
      exclude: { path: '^hub/web/src/routeTree\\.gen\\.ts$' },
    },
  }
}
