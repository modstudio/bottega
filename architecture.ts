import { dirname, join, normalize } from 'node:path'
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
type ImportBoundary = { name: string; file: string; allowed: string[]; reason: string }

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

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
  reason,
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

export const modules: ArchitectureModule[] = [
  module('orchestrator/src/artifact-paths.ts', ['node:path']),
  module('orchestrator/src/branch-landing-record.ts', ['./branch-state.ts']),
  module('orchestrator/src/branch-state.ts', ['./merged-pull-request.ts']),
  module('orchestrator/src/merged-pull-request.ts', ['./git-environment.ts', './projects.ts']),
  module('orchestrator/src/other-branch-state.ts', [
    './branch-state.ts',
    './merged-pull-request.ts',
  ]),
  module('orchestrator/src/branch-settlement.ts', [
    './db.ts',
    './evidence-query.ts',
    './resource-claims.ts',
  ]),
  module('orchestrator/src/branches.ts', [
    './branch-landing-record.ts',
    './branch-state.ts',
    './branch-settlement.ts',
    './db.ts',
    './git-environment.ts',
    './merged-pull-request.ts',
    './other-branch-state.ts',
    './projects.ts',
    './task-branch.ts',
  ]),
  module('orchestrator/src/agent-probe.ts', [
    './agent-registry.ts',
    './agents.ts',
    './capabilities.ts',
    './db.ts',
    './jobs.ts',
    './local-host.ts',
    './mcp-probe.ts',
    './transport.ts',
  ]),
  module('orchestrator/src/agent-registry.ts', ['./agents.ts', './capabilities.ts', './db.ts']),
  module('orchestrator/src/calibration-port.ts', []),
  module('orchestrator/src/capabilities.ts', []),
  module('orchestrator/src/codex-mcp-scope.ts', ['./database-location.ts', './mcp-probe.ts']),
  module('orchestrator/src/codex-schema.ts', []),
  module('orchestrator/src/env-file.ts', []),
  module('orchestrator/src/hook-tree.ts', []),
  module('orchestrator/src/keep-tree-hold.ts', []),
  module('orchestrator/src/local-host.ts', ['./agent-registry.ts', './agents.ts', './db.ts']),
  module('orchestrator/src/mcp-doc-write.ts', []),
  module('orchestrator/src/monitor.ts', [
    'node:fs',
    'node:path',
    '../../shared/brand.ts',
    './canon.ts',
    './db.ts',
    './docker-resources.ts',
    './git-locks.ts',
    './keep-tree-hold.ts',
    './mcp.ts',
    './monitor-conditions.ts',
    './monitor-notices.ts',
    './monitor-types.ts',
    './process-liveness.ts',
    './project-lock.ts',
    './projects.ts',
    './reclaim.ts',
    './grok-trust.ts',
    './idle-kill.ts',
    './resource-ownership.ts',
    './review-vocabulary.ts',
    './run-artifacts.ts',
    './worktree-attribution.ts',
  ]),
  module('orchestrator/src/monitor-conditions.ts', [
    'node:fs',
    'node:path',
    './db.ts',
    './events.ts',
    './evidence-query.ts',
    './git-environment.ts',
    './hook-tree.ts',
    './idle-kill.ts',
    './monitor-types.ts',
    './process-liveness.ts',
    './project-lock.ts',
    './projects.ts',
    './resource-claims.ts',
    './resource-inventory.ts',
    './run-alive.ts',
    './run-lease.ts',
  ]),
  module('orchestrator/src/monitor-notices.ts', [
    './db.ts',
    './monitor-conditions.ts',
    './monitor-types.ts',
    './review-vocabulary.ts',
  ]),
  module('orchestrator/src/monitor-types.ts', ['./review-vocabulary.ts']),
  module('orchestrator/src/postgres-migrate.ts', []),
  module('shared/record/schema.ts', ['../brand.ts']),
  module('shared/record/schema-auth.ts', ['./schema.ts']),
  module('shared/record/schema-run.ts', ['./schema.ts']),
  module('shared/record/schema-review.ts', ['./schema.ts']),
  module('shared/record/schema-landing.ts', ['./schema.ts']),
  module('shared/record/schema-docs.ts', ['./schema.ts']),
  module('shared/record/schema-hub.ts', ['./schema.ts']),
  module('shared/record/schema-snapshots.ts', ['./schema.ts']),
  module('shared/record-session.ts', ['./brand.ts']),
  module('orchestrator/src/record-command.ts', [
    './postgres-migrate.ts',
    './record-doctor.ts',
    './record-space.ts',
  ]),
  module('orchestrator/src/record-snapshots.ts', ['bun', '../../shared/record/schema.ts']),
  module('orchestrator/src/record-doctor.ts', [
    './postgres-migrate.ts',
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
  module('orchestrator/src/landing-outbox.ts', ['../../shared/record/schema.ts']),
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
  module('orchestrator/src/reclaim-residue-policy.ts', []),
  module('orchestrator/src/reclaim-residue.ts', [
    'node:fs',
    'node:path',
    './agent-registry.ts',
    './db.ts',
    './git-environment.ts',
    './grok-trust.ts',
    './idle-kill.ts',
    './process-liveness.ts',
    './project-lock.ts',
    './projects.ts',
    './reclaim-residue-policy.ts',
    './run-artifacts.ts',
    './run-process.ts',
    './run-alive.ts',
    './run-lease.ts',
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
  module('orchestrator/src/review-outbox.ts', ['./db.ts', '../../shared/record/schema.ts']),
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
    './transport.ts',
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
    './mailbox.ts',
    './outcome.ts',
    './project-lock.ts',
    './run-process.ts',
    './sandbox.ts',
    './transport.ts',
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
  module('orchestrator/src/standard-transports.ts', ['./transport-acp.ts', './transport-cli.ts']),
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
  module('orchestrator/src/workflow-tree.ts', ['./step-catalogue.ts', './workflows.ts']),
  module('orchestrator/src/workflow-tree-files.ts', ['node:fs', 'node:path', './workflow-tree.ts']),
  module('orchestrator/src/workflow-tree-store.ts', [
    'bun:sqlite',
    'node:util',
    './db.ts',
    './step-catalogue.ts',
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
    './recipe.ts',
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
    './recipe.ts',
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
  module('hub/src/serve-lifecycle.ts', ['../../shared/process-identity.ts']),
]

// These rows replace the former one-script-per-file import checks. Each row freezes the
// dependency surface that satisfied its script, which is stricter than the old deny lists.
// biome-ignore format: one compact row per retired check keeps the manifest below its ceiling.
const importBoundaries: ImportBoundary[] = [
  boundary('agent-commands-boundary', 'orchestrator/src/agent-commands.ts', ['./agent-probe.ts', './agent-registry.ts', './args.ts', './db.ts', './local-host.ts'], 'Keep agent registry command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.'),
  boundary('canon-budget-boundary', 'orchestrator/src/canon-budget.ts', [], 'Keep canon budget policy independent of every adapter and store.'),
  boundary('canon-commands-boundary', 'orchestrator/src/canon-commands.ts', ['node:fs', 'node:path', 'zod', './canon.ts', './canon-files.ts', './canon-hydrate.ts', './canon-lint.ts', './canon-write-gate.ts', './docs.ts', './evals.ts', './projects.ts', '../../shared/ratchet.ts'], 'Keep canon command adapters independent of runs, routing, transports, the CLI, and worktrees.'),
  boundary('canon-files-boundary', 'orchestrator/src/canon-files.ts', ['node:fs', 'node:path', '../../shared/git.ts', './canon-lint.ts'], 'Keep canon file collection independent of stores, commands, runs, routing, transports, and worktrees.'),
  boundary('canon-hydrate-boundary', 'orchestrator/src/canon-hydrate.ts', ['node:path', './canon-lint.ts'], 'Keep canon hydration planning pure and independent of filesystems, stores, commands, and processes.'),
  boundary('canon-lint-boundary', 'orchestrator/src/canon-lint.ts', ['node:path', '../../shared/canon-references.ts', '../../shared/ratchet.ts', './canon-budget.ts'], 'Keep canon lint decisions pure and independent of filesystems, stores, commands, and processes.'),
  boundary('canon-write-gate-boundary', 'orchestrator/src/canon-write-gate.ts', ['./canon-lint.ts'], 'Keep canon write decisions pure and independent of filesystems, stores, commands, and processes.'),
  boundary('checkout-identity-boundary', 'orchestrator/src/checkout-identity.ts', ['node:fs', 'node:path', './git-environment.ts', './projects.ts'], 'Keep checkout addressing independent of databases and lifecycle policy.'),
  boundary('cleanup-boundary', 'orchestrator/src/cleanup.ts', ['node:fs', 'node:path', './db.ts', './docker-resources.ts', './evidence-query.ts', './git-environment.ts', './project-lock.ts', './projects.ts', './resource-claims.ts', './resource-ownership.ts', './run-authority.ts', './worktree-attribution.ts', './worktree-remove.ts', './worktree-types.ts'], 'Keep cleanup independent of transports, routing, reviews, contracts, the CLI, and durable execution.'),
  boundary('cleanup-sweep-boundary', 'orchestrator/src/cleanup-sweep.ts', ['node:fs', 'node:path', './cleanup.ts', './close-out.ts', './db.ts', './docker-resources.ts', './hook-tree.ts', './process-liveness.ts', './projects.ts', './resource-ownership.ts', './run-alive.ts', './run-artifacts.ts', './run-authority.ts', './run-lease.ts', './worktree-attribution.ts', './worktree-remove.ts', './worktree-types.ts'], 'Keep cleanup-sweep independent of transports, routing, reviews, contracts, the CLI, and durable execution.'),
  boundary('clock-boundary', 'orchestrator/src/clock.ts', [], 'Enforce the clock concern boundary: a primitive that imports nothing.'),
  boundary('close-out-boundary', 'orchestrator/src/close-out.ts', ['node:fs', 'node:path', './close-out-adoption.ts', './db.ts', './git-environment.ts', './hook-tree.ts', './idle-kill.ts', './keep-tree-hold.ts', './process-liveness.ts', './project-lock.ts', './projects.ts', './reclaim.ts', './resource-claims.ts', './resource-ownership.ts', './run-alive.ts', './run-artifacts.ts', './run-lease.ts', './run-process.ts', './worktree.ts', './worktree-attribution.ts', './worktree-remove.ts', './worktree-types.ts'], 'Keep close-out independent of routing, contracts, transports, reviews, and the CLI.'),
  boundary('confinement-ruling-boundary', 'orchestrator/src/confinement-ruling.ts', ['node:fs', './confinement.ts', './db.ts', './git-environment.ts', './projects.ts', './run-authority.ts', './run-liveness.ts'], 'Keep confinement rulings independent of transports, routing, reviews, contracts, the CLI, and durable execution.'),
  boundary('database-boundary', 'orchestrator/src/db.ts', ['bun:sqlite', 'node:crypto', 'node:fs', 'node:path', 'node:url', '../../shared/brand.ts', './contention.ts', './database-location.ts', './migrations.ts'], 'Enforce the database concern boundary.'),
  boundary('dispatch-commands-boundary', 'orchestrator/src/dispatch-commands.ts', ['node:fs', './dispatch-preflight.ts', './jobs.ts', './keep-tree-hold.ts', './projects.ts', './failover.ts', './mcp-preflight.ts'], 'Keep dispatch command adapters independent of transports, routing, worktrees, the CLI, and reviews.'),
  boundary('dispatch-preflight-boundary', 'orchestrator/src/dispatch-preflight.ts', ['./args.ts', './checkout-identity.ts', './db.ts', './git-environment.ts', './jobs.ts', './lenses.ts', './projects.ts', './review-target.ts', './worktree-caller.ts', './worktree-preflight.ts', './worktree-template.ts'], 'Keep dispatch admission independent of transports, routing, and contracts.'),
  boundary('doc-commands-boundary', 'orchestrator/src/doc-commands.ts', ['node:fs', './canon.ts', './docs.ts'], 'Keep doc commands independent of database writes beyond docs, runs, routing, transports, and the CLI.'),
  boundary('doc-write-allowed-boundary', 'orchestrator/src/doc-write-allowed.ts', ['./canon-hydrate.ts', './canon-write-gate.ts', './pack-budget.ts', './canon-lint.ts'], 'Keep document write decisions independent of stores, HTTP, filesystems, and CLI.'),
  boundary('doctor-boundary', 'orchestrator/src/doctor.ts', ['node:fs', './agent-auth.ts', './agent-registry.ts', './agents.ts', './agreement.ts', './db.ts', './docker-resources.ts', './evidence-query.ts', './keep-tree-hold.ts', './local-host.ts', './resource-claims.ts', './resource-ownership.ts', './score.ts', './worktree-attribution.ts', './worktree-lifecycle.ts', './canon.ts', './docs.ts', './pack-budget.ts', './evals.ts', './sandbox.ts', './migrations.ts', './health.ts', './projects.ts'], 'Keep doctor independent of transports, routing, run control, the CLI, and reviews by value.'),
  boundary('duel-boundary', 'orchestrator/src/duel.ts', ['./db.ts', './evidence-query.ts', './score.ts'], 'Enforce the duel concern boundary.'),
  boundary('epic-commands-boundary', 'orchestrator/src/epic-commands.ts', ['./epic.ts'], 'Keep epic command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.'),
  boundary('evidence-query-boundary', 'orchestrator/src/evidence-query.ts', ['./db.ts', './failure.ts', './hook-tree.ts', 'bun:sqlite'], 'Enforce the evidence-query concern boundary.'),
  boundary('failover-boundary', 'orchestrator/src/failover.ts', ['./agent-registry.ts', './db.ts', 'bun:sqlite', './keep-tree-hold.ts', './mcp-preflight.ts', './resume-tree.ts'], 'Keep failover independent of execution transports, contracts, and worktrees.'),
  boundary('failure-commands-boundary', 'orchestrator/src/failure-commands.ts', ['./db.ts', './failure.ts', './run-authority.ts'], 'Keep failure command adapters independent of runs, routing, transports, the CLI, and worktrees.'),
  boundary('git-environment-boundary', 'orchestrator/src/git-environment.ts', ['node:crypto', 'node:fs', 'node:os', 'node:path', '../../shared/git.ts'], 'Keep hermetic git observation independent of lifecycle and policy concerns.'),
  boundary('health-commands-boundary', 'orchestrator/src/health-commands.ts', ['../../shared/orch-contract.ts', './db.ts', './health.ts'], 'Keep health command adapters independent of runs, routing, transports, the CLI, and worktrees.'),
  boundary('isolation-boundary', 'orchestrator/src/worktree.ts', ['node:fs', './worktree-create.ts', './worktree-readonly.ts', './projects.ts', './worktree-types.ts'], 'Keep the isolation module independent of run policy and lifecycle concerns.'),
  boundary('issue-report-fields-boundary', 'orchestrator/src/issue-report-fields.ts', [], 'Keep issue report field decisions pure and independent of adapters.'),
  boundary('job-commands-boundary', 'orchestrator/src/job-commands.ts', ['./jobs.ts'], 'Keep job catalogue command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.'),
  boundary('judgement-boundary', 'orchestrator/src/judgement.ts', ['node:fs', '../../shared/record/schema.ts', './db.ts', './duel.ts', './jobs.ts', './machine-identity.ts', './record-api-client.ts', './review.ts', './review-outbox.ts', './review-triage.ts', './review-vocabulary.ts', './run-authority.ts', './run-outbox.ts', './score.ts'], 'Keep judgement independent of transports, worktrees, routing, the CLI, durable execution, dispatch, and cleanup.'),
  boundary('landing-outbox-boundary', 'orchestrator/src/landing-outbox.ts', ['../../shared/record/schema.ts', 'bun:sqlite'], 'Enforce the landing-outbox concern boundary.'),
  boundary('machine-identity-boundary', 'orchestrator/src/machine-identity.ts', ['node:os', '../../shared/record/schema.ts', './db.ts'], 'Enforce the machine-identity concern boundary.'),
  boundary('mcp-commands-boundary', 'orchestrator/src/mcp-commands.ts', ['./mcp.ts'], 'Keep MCP command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.'),
  boundary('mcp-preflight-boundary', 'orchestrator/src/mcp-preflight.ts', ['./agent-registry.ts', './jobs.ts', './projects.ts', './run-process.ts', './contract.ts'], 'Keep MCP preflight independent of execution, transport, routing, and mutation.'),
  boundary('metric-commands-boundary', 'orchestrator/src/metric-commands.ts', ['./metric.ts'], 'Keep metric command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.'),
  boundary('monitor-commands-boundary', 'orchestrator/src/monitor-commands.ts', ['node:crypto', 'node:fs', 'node:path', '../../shared/monitor-capability.ts', './db.ts', './evals.ts', './monitor.ts', './monitor-notices.ts', './process-liveness.ts', './monitor-types.ts'], 'Keep monitor command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle.'),
  boundary('port-commands-boundary', 'orchestrator/src/port-commands.ts', ['node:fs', 'node:path', './db.ts', './porting.ts', './porting-import.ts', './projects.ts'], 'Keep port commands independent of runs, routing, transports, the CLI, and worktrees.'),
  boundary('postgres-schema-auth-boundary', 'shared/record/schema-auth.ts', ['drizzle-orm/pg-core', './schema.ts'], 'Enforce the Better Auth schema concern boundary.'),
  boundary('postgres-schema-docs-boundary', 'shared/record/schema-docs.ts', ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'], 'Enforce the hosted doc schema concern boundary.'),
  boundary('postgres-schema-hub-boundary', 'shared/record/schema-hub.ts', ['drizzle-orm/pg-core', './schema.ts'], 'Enforce the hosted hub evidence schema concern boundary.'),
  boundary('postgres-schema-landing-boundary', 'shared/record/schema-landing.ts', ['drizzle-orm/pg-core', './schema.ts'], 'Enforce the hosted landing schema concern boundary.'),
  boundary('postgres-schema-review-boundary', 'shared/record/schema-review.ts', ['drizzle-orm/pg-core', './schema.ts'], 'Enforce the hosted review schema concern boundary.'),
  boundary('postgres-schema-run-boundary', 'shared/record/schema-run.ts', ['drizzle-orm', 'drizzle-orm/pg-core', './schema.ts'], 'Enforce the hosted run schema concern boundary.'),
  boundary('process-liveness-boundary', 'orchestrator/src/process-liveness.ts', ['../../shared/process-identity.ts'], 'Enforce the process-liveness concern boundary: an OS primitive that imports nothing of ours.'),
  boundary('project-commands-boundary', 'orchestrator/src/project-commands.ts', ['node:fs', './db.ts', './lenses.ts', './projects.ts', './worktree-lifecycle.ts', './worktree-template.ts'], 'Keep project commands independent of runs, routing, transports, reviews, the CLI, and worktrees by value.'),
  boundary('prompt-retarget-boundary', 'orchestrator/src/prompt-retarget.ts', ['./checkout-identity.ts'], 'Keep prompt retargeting independent of database, transport, contract, and routing concerns.'),
  boundary('recalibration-boundary', 'orchestrator/src/recalibration.ts', ['node:fs', 'node:readline/promises', './agreement.ts', './db.ts', './jobs.ts', './score.ts', 'node:stream'], 'Keep recalibration independent of transports, worktrees, routing, the CLI, durable execution, dispatch, and cleanup.'),
  boundary('recipe-lifecycle-boundary', 'orchestrator/src/recipe-lifecycle.ts', ['./recipe-schema.ts', './recipe-step.ts'], 'Keep lifecycle planning pure and independent of execution, persistence, filesystem, and the register.'),
  boundary('recipe-loader-boundary', 'orchestrator/src/recipe-loader.ts', ['node:fs', 'node:path', './recipe-schema.ts'], 'Keep tracked recipe loading independent of execution, persistence, and CLI concerns.'),
  boundary('recipe-schema-boundary', 'orchestrator/src/recipe-schema.ts', ['zod'], 'Keep the recipe schema pure and independent of file, register, and execution concerns.'),
  boundary('recipe-step-boundary', 'orchestrator/src/recipe-step.ts', ['node:path', './worktree-template.ts', './recipe-schema.ts'], 'Keep recipe step execution independent of lifecycle, persistence, claims, and register concerns.'),
  boundary('record-api-boundary', 'orchestrator/src/record-api.ts', ['hono', 'hono/cors', 'zod', './record-auth.ts', './record-docs.ts', './record-snapshots.ts', './record-verdicts.ts', './record-projects.ts', './record-runs.ts'], 'Enforce the record-api concern boundary.'),
  boundary('record-api-client-boundary', 'orchestrator/src/record-api-client.ts', ['./doc-write-allowed.ts', './record-auth.ts', './record-session.ts', './record-snapshots.ts'], 'Enforce the record API client concern boundary.'),
  boundary('record-api-server-boundary', 'orchestrator/src/record-api-server.ts', ['./postgres-migrate.ts', './record-api.ts', './record-auth.ts', './record-docs.ts', './record-projects.ts', './record-reviews.ts', './record-runs.ts', './record-snapshots.ts', './record-verdicts.ts'], 'Enforce the record-api-server concern boundary.'),
  boundary('record-auth-boundary', 'orchestrator/src/record-auth.ts', ['@better-auth/drizzle-adapter/relations-v2', 'better-auth', 'better-auth/plugins', 'bun', 'drizzle-orm/bun-sql', '../../shared/record/schema.ts', '../../shared/record/schema-auth.ts'], 'Enforce the record-auth concern boundary.'),
  boundary('record-auth-command-boundary', 'orchestrator/src/record-auth-command.ts', ['../../shared/record-session.ts', './record-auth.ts', './record-session.ts'], 'Enforce the record-auth-command concern boundary.'),
  boundary('record-cache-boundary', 'orchestrator/src/record-cache.ts', ['./db.ts', './record-api-client.ts', 'bun:sqlite'], 'Enforce the record-cache concern boundary.'),
  boundary('record-docs-boundary', 'orchestrator/src/record-docs.ts', ['bun', '../../shared/record/schema.ts', './doc-write-allowed.ts'], 'Enforce the record-docs concern boundary.'),
  boundary('record-projects-boundary', 'orchestrator/src/record-projects.ts', ['bun'], 'Keep hosted project record access isolated from other production modules.'),
  boundary('record-push-docs-boundary', 'orchestrator/src/record-push-docs.ts', ['./db.ts', './record-api-client.ts', './doc-write-allowed.ts'], 'Enforce the record-push-docs concern boundary.'),
  boundary('record-reviews-boundary', 'orchestrator/src/record-reviews.ts', ['bun', './record-runs.ts'], 'Keep hosted review record access limited to the hosted run record contract.'),
  boundary('record-runs-boundary', 'orchestrator/src/record-runs.ts', ['bun'], 'Enforce the record-runs concern boundary.'),
  boundary('record-sync-boundary', 'orchestrator/src/record-sync.ts', ['bun', 'drizzle-orm/bun-sql', '../../shared/record/schema.ts', '../../shared/record/schema-landing.ts', '../../shared/record/schema-review.ts', '../../shared/record/schema-run.ts', './db.ts', './landing-outbox.ts', './machine-identity.ts', './record-cache.ts', './record-session.ts', './review-outbox.ts', './run-outbox.ts', './score-outbox.ts', 'bun:sqlite'], 'Enforce the record-sync concern boundary.'),
  boundary('record-sync-command-boundary', 'orchestrator/src/record-sync-command.ts', ['./record-sync.ts'], 'Enforce the record-sync-command concern boundary.'),
  boundary('record-verdicts-boundary', 'orchestrator/src/record-verdicts.ts', ['bun', './score.ts'], 'Enforce the record-verdicts concern boundary.'),
  boundary('resource-ownership-boundary', 'orchestrator/src/resource-ownership.ts', ['node:fs', 'node:path', './checkout-identity.ts', './database-location.ts', './db.ts', './docker-resources.ts', './evidence-query.ts', './git-environment.ts', './process-liveness.ts', './project-lock.ts', './run-alive.ts', './run-lease.ts', 'bun:sqlite'], 'Enforce the resource-ownership concern boundary.'),
  boundary('review-commands-boundary', 'orchestrator/src/review-commands.ts', ['bun:sqlite', 'node:fs', 'zod', './db.ts', './git-environment.ts', './jobs.ts', './projects.ts', './review.ts', './review-calibration.ts', './review-coverage.ts', './review-evidence-sql.ts', './review-pins.ts', './review-tier.ts', './review-triage.ts', './review-vocabulary.ts', './review-yield.ts'], 'Keep review commands independent of runs, transports, routing by value, the CLI, and worktrees by value.'),
  boundary('review-outbox-boundary', 'orchestrator/src/review-outbox.ts', ['../../shared/record/schema.ts', './db.ts', 'bun:sqlite'], 'Enforce the review-outbox concern boundary.'),
  boundary('review-target-boundary', 'orchestrator/src/review-target.ts', ['node:path', './git-environment.ts', './projects.ts', './worktree-caller.ts'], 'Keep review-target resolution independent of execution and mutation concerns.'),
  boundary('review-vocabulary-boundary', 'orchestrator/src/review-vocabulary.ts', [], 'Enforce the review-vocabulary concern boundary.'),
  boundary('routing-commands-boundary', 'orchestrator/src/routing-commands.ts', ['./agreement.ts', './duel.ts', './guide.ts', './lenses.ts', './projects.ts', './route.ts', './routing-backtest.ts'], 'Keep routing command adapters independent of runs, transports, the CLI, worktrees, and reviews by value.'),
  boundary('run-answer-boundary', 'orchestrator/src/run-answer.ts', ['node:fs', './agent-registry.ts', './args.ts', './clock.ts', './contract.ts', './db.ts', './failover.ts', './jobs.ts', './keep-tree-hold.ts', './mcp-preflight.ts', './outcome.ts', './process-liveness.ts', './run.ts', './run-artifacts.ts', './run-authority.ts', './run-control.ts', './run-dispatch.ts', './git-environment.ts'], 'Keep run-answer independent of transports, worktrees, routing, reviews, and the CLI.'),
  boundary('run-artifacts-boundary', 'orchestrator/src/run-artifacts.ts', ['node:fs', 'node:path', './artifact-paths.ts', './database-location.ts', './db.ts', './migrations.ts', './resource-ownership.ts'], 'Keep run artifacts independent of routing, contracts, transports, reviews, and isolation.'),
  boundary('run-authority-boundary', 'orchestrator/src/run-authority.ts', ['./db.ts', 'bun:sqlite'], 'Enforce the run-authority concern boundary.'),
  boundary('run-control-boundary', 'orchestrator/src/run-control.ts', ['node:fs', './args.ts', './clock.ts', './collect.ts', './db.ts', './events.ts', './failover.ts', './git-environment.ts', './mcp-preflight.ts', './outcome.ts', './projects.ts', './resume-tree.ts', './run.ts', './run-authority.ts', './run-dispatch.ts', './run-liveness.ts', './checkpoint.ts'], 'Keep run-control independent of transports, worktrees, routing, reviews, and the CLI.'),
  boundary('run-diff-boundary', 'orchestrator/src/run-diff.ts', ['node:fs', './db.ts', './git-environment.ts', './projects.ts'], 'Keep run diff independent of run control, transports, routing, the CLI, and worktrees by value.'),
  boundary('run-dispatch-boundary', 'orchestrator/src/run-dispatch.ts', ['node:child_process', 'node:crypto', 'node:fs', './db.ts', './dispatch-preflight.ts', './jobs.ts', './mcp-preflight.ts', './projects.ts', './run.ts', './run-artifacts.ts', './failover.ts'], 'Keep run-dispatch independent of transports, worktrees, routing, reviews, and the CLI.'),
  boundary('run-inbox-boundary', 'orchestrator/src/run-inbox.ts', ['./db.ts', './evidence-query.ts', './projects.ts'], 'Keep run inbox independent of run control, transports, routing, the CLI, and worktrees.'),
  boundary('run-listing-boundary', 'orchestrator/src/run-listing.ts', ['./collect.ts', './db.ts', './evidence-query.ts', './outcome.ts', './events.ts', './idle-kill.ts'], 'Keep run listing independent of run control, transports, routing, the CLI, and worktrees.'),
  boundary('run-liveness-boundary', 'orchestrator/src/run-liveness.ts', ['./db.ts', './process-liveness.ts', './resource-ownership.ts', './run-alive.ts', './run-authority.ts', './run-lease.ts', 'bun:sqlite'], 'Enforce the run-liveness concern boundary.'),
  boundary('run-outbox-boundary', 'orchestrator/src/run-outbox.ts', ['../../shared/record/schema.ts', './hook-tree.ts', 'bun:sqlite'], 'Enforce the run-outbox concern boundary.'),
  boundary('run-process-boundary', 'orchestrator/src/run-process.ts', ['node:crypto', './checkpoint.ts', './db.ts', './dispatch-preflight.ts', './idle-kill.ts', './agent-registry.ts'], 'Keep run process control independent of routing, contracts, reviews, and transports.'),
  boundary('run-stop-boundary', 'orchestrator/src/run-stop.ts', ['./cleanup.ts', './db.ts', './resource-ownership.ts', './run-authority.ts', './run-liveness.ts', './worktree-remove.ts', './worktree-types.ts'], 'Keep run-stop independent of transports, routing, reviews, contracts, the CLI, and durable execution.'),
  boundary('score-boundary', 'orchestrator/src/score.ts', [], 'Enforce the score concern boundary.'),
  boundary('store-hooks-boundary', 'orchestrator/src/store-hooks.ts', ['./db.ts', './evidence-query.ts', './run-liveness.ts', './workflow-seeds.ts'], 'Enforce the store-hooks concern boundary.'),
  boundary('task-branch-boundary', 'orchestrator/src/task-branch.ts', ['./checkout-identity.ts', './db.ts', './git-environment.ts', './projects.ts', './review-evidence-sql.ts', './branch-state.ts', './worktree-types.ts'], 'Keep task branch identity independent of transports, contracts, and routing.'),
  boundary('workflows-boundary', 'orchestrator/src/workflow-seeds.ts', ['./db.ts', './review-vocabulary.ts', 'bun:sqlite'], 'Keep workflow seeds dependent only on database transactions and review vocabulary.'),
  boundary('worktree-attribution-boundary', 'orchestrator/src/worktree-attribution.ts', ['node:fs', 'node:path', './checkout-identity.ts', './database-location.ts', './db.ts', './git-environment.ts', './worktree-types.ts'], 'Keep attribution and extraction independent of lifecycle policy and transports.'),
  boundary('worktree-mcp-boundary', 'orchestrator/src/worktree-mcp.ts', ['node:fs', 'node:path'], 'Keep worker MCP file provisioning independent of lifecycle and policy.'),
  boundary('worktree-template-boundary', 'orchestrator/src/worktree-template.ts', [], 'Keep template grammar independent of execution, lifecycle, and policy.'),
]

export const inversions: ArchitectureInversion[] = [
  { from: 'orchestrator/src/jobs.ts', to: 'orchestrator/src/agents.ts' },
  { from: 'orchestrator/src/route.ts', to: 'orchestrator/src/review.ts' },
  { from: 'orchestrator/src/review.ts', to: 'orchestrator/src/route.ts' },
  { from: 'orchestrator/src/transport.ts', to: 'orchestrator/src/agents.ts' },
  { from: 'orchestrator/src/transport.ts', to: 'orchestrator/src/transport-cli.ts' },
  { from: 'orchestrator/src/transport.ts', to: 'orchestrator/src/transport-acp.ts' },
]

const allowedCycles: ArchitectureCycle[] = [
  {
    cycle: ['orchestrator/src/canon.ts', 'orchestrator/src/docs.ts', 'orchestrator/src/canon.ts'],
    reason: 'Pre-existing operator-doc/canon compilation cycle outside the specified inversions.',
  },
]

export const exactArchitecturePath = (path: string) =>
  `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`

function architectureDependencyPath(target: string) {
  if (target.startsWith('node:')) return exactArchitecturePath(target.slice('node:'.length))
  if (target === 'bun') return '^node_modules/\\.bun/[^/]+/node_modules/@types/bun/'
  if (target.includes(':')) return exactArchitecturePath(target)
  if (CONCERNS.some((root) => target.startsWith(`${root}/`)) || target.startsWith('shared/')) {
    return exactArchitecturePath(target)
  }
  const [first, second, ...remainder] = target.split('/')
  const packageName = first?.startsWith('@') ? `${first}/${second}` : first!
  const packagePath = first?.startsWith('@') ? remainder : [second, ...remainder].filter(Boolean)
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedPath = packagePath.map((part) => part!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const installed = `^node_modules/\\.bun/[^/]+/node_modules/${escapedPackage}/`
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
      to: { pathNot: entry.allowed.map(architectureDependencyPath) },
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
      exclude: { path: '(^|/)node_modules/|^hub/web/src/routeTree\\.gen\\.ts$' },
    },
  }
}
