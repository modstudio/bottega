import { dirname, join, normalize } from 'node:path'
import { CONCERNS } from '../shared/brand.ts'
import { importBoundaries } from './architecture-boundaries.ts'

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
  module('retrieval/src/corpus/chunks.ts', ['node:fs/promises', 'node:path', 'bun']),
  module('retrieval/src/services/endpoints.ts', []),
  module('retrieval/src/benchmark/metrics.ts', ['../corpus/chunks.ts']),
  module('retrieval/src/benchmark/queries.ts', []),
  module('retrieval/src/benchmark/keyword.ts', ['../corpus/chunks.ts']),
  module('retrieval/src/benchmark/benchmark.ts', [
    'node:fs/promises',
    'node:path',
    '../corpus/chunks.ts',
    '../services/endpoints.ts',
    './keyword.ts',
    './metrics.ts',
    './queries.ts',
  ]),
  module('orchestrator/src/artifact-paths.ts', ['node:path']),
  module('orchestrator/src/branch/branch-landing-record.ts', ['./branch-state.ts']),
  module('orchestrator/src/branch/branch-state.ts', ['./merged-pull-request.ts']),
  module('orchestrator/src/branch/merged-pull-request.ts', [
    '../git/git-environment.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/branch/other-branch-state.ts', [
    './branch-state.ts',
    './merged-pull-request.ts',
  ]),
  module('orchestrator/src/branch/branch-settlement.ts', [
    '../database/db.ts',
    '../evidence/evidence-query.ts',
    '../resources/resource-claims.ts',
  ]),
  module('orchestrator/src/branch/branches.ts', [
    './branch-landing-record.ts',
    './branch-state.ts',
    './branch-settlement.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    './merged-pull-request.ts',
    './other-branch-state.ts',
    '../project/projects.ts',
    './task-branch.ts',
  ]),
  module('orchestrator/src/agent/agent-probe.ts', [
    './agent-registry.ts',
    './agents.ts',
    './capabilities.ts',
    '../database/db.ts',
    '../jobs/jobs.ts',
    './model-host.ts',
    '../mcp/mcp-probe.ts',
    '../transport/transport.ts',
  ]),
  module('orchestrator/src/agent/agent-registry.ts', [
    './agents.ts',
    './capabilities.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/runtime/calibration-port.ts', []),
  module('orchestrator/src/agent/capabilities.ts', []),
  module('orchestrator/src/mcp/mcp-tool-list.ts', [
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/client/stdio.js',
    '@modelcontextprotocol/sdk/client/streamableHttp.js',
  ]),
  module('orchestrator/src/sandbox/codex-mcp-preflight.ts', [
    '../mcp/mcp-tool-list.ts',
    './codex-mcp-scope.ts',
  ]),
  module('orchestrator/src/sandbox/codex-mcp-scope.ts', [
    '../database/database-location.ts',
    '../mcp/mcp-probe.ts',
    '../mcp/mcp-tool-list.ts',
  ]),
  module('orchestrator/src/contract/codex-schema.ts', []),
  module('orchestrator/src/recipe/env-file.ts', []),
  module('orchestrator/src/hook-tree/hook-tree.ts', []),
  module('orchestrator/src/worktree/keep-tree-hold.ts', []),
  module('orchestrator/src/agent/model-host.ts', [
    '../../../shared/machine-config.ts',
    '../../../shared/state-directory.ts',
    './agent-registry.ts',
    './agents.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/mcp/mcp-doc-write.ts', []),
  module('orchestrator/src/mcp/mcp-prompts.ts', [
    '@modelcontextprotocol/sdk/server/mcp.js',
    'zod',
    '../project/projects.ts',
    '../workflow/workflow-render.ts',
    '../workflow/workflows.ts',
  ]),
  module('orchestrator/src/workflow/workflow-render.ts', ['./workflows.ts']),
  module('orchestrator/src/monitor/monitor.ts', [
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../canon/canon.ts',
    '../database/db.ts',
    '../resources/docker-resources.ts',
    '../resources/git-locks.ts',
    '../worktree/keep-tree-hold.ts',
    '../mcp/mcp.ts',
    './monitor-conditions.ts',
    './monitor-notices.ts',
    './monitor-types.ts',
    '../../../shared/process-identity.ts',
    '../project/project-lock.ts',
    '../project/projects.ts',
    '../reclaim/reclaim.ts',
    '../sandbox/grok-trust.ts',
    '../idle-kill.ts',
    '../resources/resource-ownership.ts',
    '../review/review-vocabulary.ts',
    '../run/run-artifacts.ts',
    '../worktree/worktree-attribution.ts',
  ]),
  module('orchestrator/src/monitor/monitor-conditions.ts', [
    'node:fs',
    'node:path',
    '../database/db.ts',
    '../events.ts',
    '../evidence/evidence-query.ts',
    '../git/git-environment.ts',
    '../hook-tree/hook-tree.ts',
    '../idle-kill.ts',
    './monitor-types.ts',
    '../../../shared/process-identity.ts',
    '../project/project-lock.ts',
    '../project/projects.ts',
    '../resources/resource-claims.ts',
    '../resources/resource-inventory.ts',
    '../run/run-alive.ts',
    '../run/run-lease.ts',
  ]),
  module('orchestrator/src/monitor/monitor-notices.ts', [
    '../database/db.ts',
    './monitor-conditions.ts',
    './monitor-types.ts',
    '../review/review-vocabulary.ts',
  ]),
  module('orchestrator/src/monitor/monitor-types.ts', ['../review/review-vocabulary.ts']),
  module('orchestrator/src/mail/password-reset-mailer.ts', [
    '@aws-sdk/client-sesv2',
    '../../../shared/brand.ts',
  ]),
  module('hub/src/report-renderer.ts', ['../../shared/compact-number.ts', './measures.ts']),
  module('hub/src/report-delivery.ts', ['./measures.ts', './report-renderer.ts']),
  module('hub/src/report-delivery-hosted.ts', [
    'node:os',
    '@aws-sdk/client-sesv2',
    'bun',
    '../../shared/record/schema.ts',
    './hosted-measures.ts',
    './hosted-report-gather.ts',
    './hosted-tasks.ts',
    './report-delivery.ts',
  ]),
  module('hub/src/hosted-report-gather.ts', [
    '../../shared/interval.ts',
    './measures.ts',
    './report-delivery.ts',
    './report-renderer.ts',
    './hosted-tasks.ts',
  ]),
  module('orchestrator/src/postgres/postgres-migrate.ts', []),
  module('shared/gate-timing-directory.ts', ['./brand.ts', './state-directory.ts']),
  module('shared/config-directory.ts', ['node:path', './brand.ts']),
  module('shared/env-source.ts', ['node:fs', 'node:util', './config-directory.ts']),
  module('shared/machine-config.ts', ['node:fs', 'node:path', 'zod', './config-directory.ts']),
  module('shared/state-directory.ts', ['./brand.ts']),
  module('shared/record/schema.ts', ['../brand.ts']),
  module('shared/record-session.ts', ['./brand.ts']),
  module('orchestrator/src/record/record-command.ts', [
    '../postgres/postgres-migrate.ts',
    '../project/projects.ts',
    './record-doctor.ts',
    './record-space-move.ts',
    './record-space.ts',
  ]),
  module('orchestrator/src/record/record-attribution.ts', [
    'bun:sqlite',
    '../database/db.ts',
    './record-api-client.ts',
    './record-session.ts',
  ]),
  module('orchestrator/src/record/record-doctor.ts', [
    '../postgres/postgres-migrate.ts',
    '../../../shared/record/schema.ts',
    './record-attribution.ts',
    './record-auth.ts',
    './record-session.ts',
    './record-sync.ts',
  ]),
  module('orchestrator/src/record/record-session.ts', [
    '../../../shared/record-session.ts',
    '../database/db.ts',
    './record-auth.ts',
  ]),
  module('orchestrator/src/record/record-space.ts', [
    '../../../shared/record/schema.ts',
    './record-auth.ts',
    './record-session.ts',
  ]),
  module('orchestrator/src/record/record-space-move.ts', [
    'bun',
    '../postgres/postgres-migrate.ts',
    './record-session.ts',
    './record-space.ts',
  ]),
  module('orchestrator/src/score/score-outbox.ts', ['../../../shared/record/schema.ts']),
  module('orchestrator/src/project/project-lock.ts', [
    '../database/db.ts',
    '../git/git-environment.ts',
    '../../../shared/process-identity.ts',
  ]),
  module('orchestrator/src/project/project-injection.ts', ['zod', '../../../shared/trackers.ts']),
  module('orchestrator/src/resources/ref-guard.ts', [
    '../database/db.ts',
    '../../../shared/process-identity.ts',
    '../worktree/worktree-attribution.ts',
    '../git/git-environment.ts',
  ]),
  module('orchestrator/src/reclaim/reclaim-residue-policy.ts', []),
  module('orchestrator/src/reclaim/reclaim-worktree-dirty.ts', []),
  module('orchestrator/src/reclaim/reclaim-residue.ts', [
    'node:fs',
    'node:path',
    '../agent/agent-registry.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    '../sandbox/grok-trust.ts',
    '../idle-kill.ts',
    '../../../shared/process-identity.ts',
    '../project/project-lock.ts',
    '../project/projects.ts',
    './reclaim-residue-policy.ts',
    '../run/run-artifacts.ts',
    '../run/run-process.ts',
    '../run/run-alive.ts',
    '../run/run-lease.ts',
  ]),
  module('orchestrator/src/resources/resource-claims.ts', ['../hook-tree/hook-tree.ts']),
  module('orchestrator/src/run/resume-tree.ts', []),
  module('orchestrator/src/review/review-calibration.ts', [
    '../database/db.ts',
    './review-vocabulary.ts',
    '../state/statistics.ts',
    './review-evidence-sql.ts',
    './review-triage.ts',
  ]),
  module('orchestrator/src/review/review-coverage.ts', [
    '../database/db.ts',
    './change-identity.ts',
    './review-evidence-sql.ts',
    './review-pins.ts',
    './review-types.ts',
  ]),
  module('orchestrator/src/review/review-coverage-match.ts', []),
  module('orchestrator/src/review/review-evidence-sql.ts', ['../evidence/evidence-query.ts']),
  module('orchestrator/src/review/review-pins.ts', [
    '../database/db.ts',
    '../git/git-environment.ts',
    './change-identity.ts',
    './review-types.ts',
  ]),
  module('orchestrator/src/review/review-triage.ts', [
    '../database/db.ts',
    './review-vocabulary.ts',
    '../contract/contract.ts',
    './review.ts',
    './review-outbox.ts',
  ]),
  module('orchestrator/src/review/review-types.ts', [
    './review-vocabulary.ts',
    './change-identity.ts',
  ]),
  module('orchestrator/src/run/run-alive.ts', []),
  module('orchestrator/src/run/run-claim.ts', [
    '../agent/agents.ts',
    '../contract/codex-schema.ts',
    '../canon/canon.ts',
    '../git/checkout-identity.ts',
    '../contract/contract.ts',
    '../database/db.ts',
    '../dispatch/dispatch-preflight.ts',
    '../events.ts',
    '../route/failover.ts',
    '../git/git-environment.ts',
    '../sandbox/grok-trust.ts',
    '../worktree/keep-tree-hold.ts',
    '../mcp/mcp-preflight.ts',
    '../mcp/mcp-probe.ts',
    '../project/project-lock.ts',
    '../project/projects.ts',
    '../dispatch/prompt-retarget.ts',
    '../../../shared/record/schema.ts',
    '../resources/resource-claims.ts',
    '../resources/resource-ownership.ts',
    '../review/review-target.ts',
    './run-artifacts.ts',
    './run-process.ts',
    './resume-tree.ts',
    '../sandbox/sandbox.ts',
    '../branch/task-branch.ts',
    '../worktree/worktree.ts',
    '../worktree/worktree-caller.ts',
    '../worktree/worktree-mcp.ts',
    '../worktree/worktree-preflight.ts',
    '../worktree/worktree-remove.ts',
    '../worktree/worktree-types.ts',
  ]),
  module('orchestrator/src/run/run-close.ts', [
    '../close/close-out.ts',
    '../contract/contract.ts',
    '../database/db.ts',
    '../route/failover.ts',
    '../failure/failure.ts',
    '../jobs/jobs.ts',
    '../worktree/keep-tree-hold.ts',
    '../mcp/mcp-preflight.ts',
    '../project/projects.ts',
    '../review/review-calibration.ts',
    '../route/route.ts',
    './run-process.ts',
    './run-types.ts',
    '../transport/transport.ts',
    '../worktree/worktree-remove.ts',
    '../worktree/worktree-types.ts',
  ]),
  module('orchestrator/src/run/run-lease.ts', [
    '../database/database-location.ts',
    '../project/project-lock.ts',
    './run-alive.ts',
  ]),
  module('orchestrator/src/run/run-live.ts', [
    '../agent/agents.ts',
    '../ask/ask.ts',
    './checkpoint.ts',
    '../sandbox/codex-mcp-scope.ts',
    '../confinement/confinement.ts',
    '../contract/contract.ts',
    '../database/db.ts',
    '../events.ts',
    '../failure/failure.ts',
    '../git/git-environment.ts',
    '../idle-kill.ts',
    '../jobs/jobs.ts',
    '../mailbox/mailbox-notice.ts',
    '../mailbox/mailbox.ts',
    '../live-outcome.ts',
    '../outcome.ts',
    '../project/project-lock.ts',
    './run-process.ts',
    '../sandbox/sandbox.ts',
    '../transport/transport.ts',
    '../worktree/worktree-types.ts',
  ]),
  module('orchestrator/src/run/run-termination.ts', []),
  module('orchestrator/src/live-outcome.ts', [
    './failure/failure.ts',
    './outcome.ts',
    './run/run-process.ts',
    './transport/transport.ts',
  ]),
  module('orchestrator/src/run/run-terminal.ts', [
    '../ask/ask.ts',
    './checkpoint.ts',
    '../confinement/confinement.ts',
    '../contract/contract.ts',
    '../database/db.ts',
    '../evidence/evidence.ts',
    '../failure/failure.ts',
    '../idle-kill.ts',
    '../jobs/jobs.ts',
    '../record/machine-identity.ts',
    '../mcp/mcp-preflight.ts',
    '../outcome.ts',
    '../project/projects.ts',
    '../resources/resource-ownership.ts',
    '../review/review.ts',
    './run-artifacts.ts',
    './run-liveness.ts',
    './run-outbox.ts',
    './run-process.ts',
    '../sandbox/sandbox.ts',
    '../worktree/worktree-remove.ts',
    '../worktree/worktree-types.ts',
  ]),
  module('orchestrator/src/run/run-types.ts', [
    '../contract/contract.ts',
    '../worktree/worktree-remove.ts',
    '../worktree/worktree-types.ts',
  ]),
  module('orchestrator/src/runtime/runtime-registration.ts', [
    './standard-calibration.ts',
    './store-hooks.ts',
    './standard-transports.ts',
  ]),
  module('orchestrator/src/transport/acp-trace.ts', [
    'node:child_process',
    'node:fs',
    'node:path',
    'node:stream',
  ]),
  module('orchestrator/src/sandbox/sandbox.ts', [
    '../../../shared/config-directory.ts',
    '../database/db.ts',
    '../mcp/mcp-probe.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/runtime/standard-calibration.ts', [
    './calibration-port.ts',
    '../review/review-calibration.ts',
  ]),
  module('orchestrator/src/runtime/standard-transports.ts', [
    '../transport/transport-acp.ts',
    '../transport/transport-cli.ts',
  ]),
  module('orchestrator/src/state/statistics.ts', []),
  module('orchestrator/src/hook-tree/tree-commands.ts', ['./tree.ts']),
  module('orchestrator/src/hook-tree/tree.ts', [
    'node:crypto',
    'node:fs',
    'node:path',
    '../close/close-out.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    './hook-tree.ts',
    '../project/projects.ts',
    '../resources/resource-claims.ts',
    '../run/run-lease.ts',
    '../recipe/tracked-recipe.ts',
    '../worktree/worktree-create.ts',
    '../worktree/worktree-lifecycle.ts',
    '../worktree/worktree-types.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree.ts', ['./step-catalogue.ts', './workflows.ts']),
  module('orchestrator/src/workflow/workflow-tree-files.ts', [
    'node:fs',
    'node:path',
    './workflow-tree.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-store.ts', [
    'bun:sqlite',
    'node:util',
    '../database/db.ts',
    './step-catalogue.ts',
    './workflow-tree.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/worktree/worktree-caller.ts', [
    '../project/projects.ts',
    '../git/git-environment.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-create.ts', [
    '../database/db.ts',
    '../project/projects.ts',
    '../recipe/recipe.ts',
    '../recipe/tracked-recipe.ts',
    './worktree-template.ts',
    './worktree-attribution.ts',
    '../git/git-environment.ts',
    '../project/project-lock.ts',
    './worktree-remove.ts',
    './worktree-caller.ts',
    './worktree-tool.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-preflight.ts', [
    '../project/projects.ts',
    './worktree-template.ts',
    '../git/git-environment.ts',
  ]),
  module('orchestrator/src/worktree/worktree-readonly.ts', [
    '../project/projects.ts',
    './readonly-provision.ts',
    './worktree-template.ts',
    '../git/git-environment.ts',
    './worktree-remove.ts',
    './worktree-create.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-remove.ts', [
    '../database/db.ts',
    '../project/projects.ts',
    '../recipe/recipe.ts',
    '../recipe/tracked-recipe.ts',
    './worktree-attribution.ts',
    '../git/git-environment.ts',
    '../resources/ref-guard.ts',
    '../resources/resource-claims.ts',
    './worktree-tool.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-tool.ts', [
    './worktree-template.ts',
    '../git/git-environment.ts',
  ]),
  module('orchestrator/src/worktree/worktree-types.ts', []),
  module('hub/src/fixture-question-reclaim.ts', ['./db.ts', './orch.ts', './reconcile.ts']),
  module('hub/src/serve-lifecycle.ts', [
    '../../shared/process-identity.ts',
    '../../shared/state-directory.ts',
  ]),
]

export const inversions: ArchitectureInversion[] = [
  { from: 'orchestrator/src/jobs/jobs.ts', to: 'orchestrator/src/agent/agents.ts' },
  { from: 'orchestrator/src/route/route.ts', to: 'orchestrator/src/review/review.ts' },
  { from: 'orchestrator/src/review/review.ts', to: 'orchestrator/src/route/route.ts' },
  { from: 'orchestrator/src/transport/transport.ts', to: 'orchestrator/src/agent/agents.ts' },
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
      'orchestrator/src/canon/canon.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/canon/canon.ts',
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
  if (!escapedPath.length) return installed
  const packageSubpath = escapedPath.join('/')
  const installedCandidates = Array.from(
    { length: 5 },
    (_, depth) => `${installed}${'[^/]+/'.repeat(depth)}${packageSubpath}`,
  )
  const installedResolutions = installedCandidates.flatMap((candidate) => [
    `${candidate}$`,
    `${candidate}\\.[^/]+$`,
    `${candidate}/index$`,
    `${candidate}/index\\.[^/]+$`,
  ])
  return `${installedResolutions.join('|')}|${unresolved}`
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
      to: { path: exactArchitecturePath('orchestrator/src/run/run.ts') },
    },
    {
      name: 'import-record-api-server-transitive-boundary',
      severity: 'error',
      comment: 'Enforce the record-api-server concern boundary.',
      from: { path: exactArchitecturePath('orchestrator/src/record/record-api-server.ts') },
      to: {
        path: '^(?:orchestrator/src/(?:database-location|db)\\.ts|bun:sqlite)$',
        reachable: true,
      },
    },
    {
      name: 'import-hosted-report-delivery-no-local-store-transitive-boundary',
      severity: 'error',
      comment: 'Hosted report delivery must render and send without the local SQLite store or git.',
      from: {
        path: [
          'hub/src/report-delivery.ts',
          'hub/src/report-delivery-hosted.ts',
          'hub/src/report-delivery-cli.ts',
        ]
          .map(exactArchitecturePath)
          .join('|'),
      },
      to: {
        path: ['hub/src/db.ts', 'shared/git.ts', 'bun:sqlite']
          .map(architectureDependencyPath)
          .join('|'),
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
      tsConfig: { fileName: join(import.meta.dir, '..', 'orchestrator/tsconfig.json') },
      tsPreCompilationDeps: true,
      doNotFollow: { path: 'node_modules' },
      exclude: { path: '^hub/web/src/routeTree\\.gen\\.ts$' },
    },
  }
}
