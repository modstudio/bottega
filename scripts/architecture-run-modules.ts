export const runModuleSpecs = [
  {
    file: 'orchestrator/src/jobs/delegation.ts',
    allowed: ['../../../shared/brand.ts', '../../../shared/delegation-mode.ts', './jobs.ts'],
  },
  {
    file: 'orchestrator/src/health/delegation-doctor.ts',
    allowed: ['../../../shared/delegation-mode.ts', '../jobs/delegation.ts', '../jobs/jobs.ts'],
  },
  {
    file: 'orchestrator/src/run/run-subscription-cost.ts',
    allowed: ['../agent/agents.ts'],
  },
  {
    file: 'orchestrator/src/run/run-subscription-cost-store.ts',
    allowed: ['bun:sqlite', '../database/db.ts', './run-subscription-cost.ts'],
  },
  {
    file: 'orchestrator/src/run/run-subscription-prices.ts',
    allowed: [
      '../../../shared/config-client.ts',
      '../config/config-service.ts',
      './run-subscription-cost.ts',
      './run-subscription-cost-store.ts',
    ],
  },
  {
    file: 'orchestrator/src/run/run-usage-columns.ts',
    allowed: ['../transport/quota-readings.ts', '../transport/vendor-usage.ts'],
  },
  {
    file: 'orchestrator/src/run/run-mcp-mode.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/run-mcp-launch-scope.ts',
    allowed: [
      '../agent/agents.ts',
      '../mcp/mcp-probe.ts',
      '../project/projects.ts',
      '../sandbox/codex-mcp-scope.ts',
      '../sandbox/project-mcp-scope.ts',
      './run-mcp-mode.ts',
      './run-worker-home.ts',
    ],
  },
  {
    file: 'orchestrator/src/run/stopped-worktree-decision.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/run-number.ts',
    allowed: ['bun:sqlite', '../database/entity-number.ts'],
  },
  {
    file: 'orchestrator/src/run/run-identifier-grammar.ts',
    allowed: ['../../../shared/record-id.ts'],
  },
  {
    file: 'orchestrator/src/run/question-number.ts',
    allowed: ['bun:sqlite', '../database/entity-number.ts'],
  },
  {
    file: 'orchestrator/src/evidence/premature-final.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/route/prompt-size-bucket.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/route/route-policy.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/route/route-selection.ts',
    allowed: ['../score/score.ts', './route-cost-policy.ts', './route-policy.ts'],
  },
  {
    file: 'orchestrator/src/route/route-metered-policy.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/route/route-metered-policy-adapter.ts',
    allowed: ['../agent/agents.ts', '../jobs/jobs.ts', './route-metered-policy.ts'],
  },
  {
    file: 'orchestrator/src/route/route-cost-policy.ts',
    allowed: ['./route-policy.ts'],
  },
  {
    file: 'orchestrator/src/route/route-cost-policy-adapter.ts',
    allowed: ['../../../shared/machine-config.ts', './route-cost-policy.ts'],
  },
  {
    file: 'orchestrator/src/route/route-cost-backtest.ts',
    allowed: [
      '../state/statistics.ts',
      './prompt-size-bucket.ts',
      './route-cost-policy.ts',
      './route-selection.ts',
    ],
  },
  {
    file: 'orchestrator/src/route/route-cost-backtest-adapter.ts',
    allowed: [
      '../agent/agent-registry.ts',
      '../database/db.ts',
      '../jobs/job-fidelity.ts',
      '../jobs/jobs.ts',
      '../review/review-tier-classifier.ts',
      '../run/run-subscription-cost.ts',
      '../state/statistics.ts',
      './prompt-size-bucket.ts',
      './route.ts',
      './route-cost.ts',
      './route-cost-backtest.ts',
      './route-cost-policy.ts',
      './route-selection.ts',
      './route-statistics.ts',
      './routing-backtest.ts',
    ],
  },
  {
    file: 'orchestrator/src/route/route-statistics.ts',
    allowed: ['../state/statistics.ts'],
  },
  {
    file: 'orchestrator/src/route/route-cost.ts',
    allowed: [
      '../database/db.ts',
      '../jobs/job-fidelity.ts',
      '../run/run-subscription-cost.ts',
      '../run/run-subscription-cost-store.ts',
      './prompt-size-bucket.ts',
      './route-statistics.ts',
    ],
  },
  {
    file: 'orchestrator/src/route/routing-refusal.ts',
    allowed: ['../refusal-error.ts'],
  },
  {
    file: 'orchestrator/src/route/harness-delegation.ts',
    allowed: [
      '../../../shared/machine-config.ts',
      '../jobs/delegation.ts',
      '../jobs/jobs.ts',
      './routing-refusal.ts',
    ],
  },
  {
    file: 'orchestrator/src/route/running-runs.ts',
    allowed: ['bun:sqlite', '../agent/worker-launch-env.ts', '../database/db.ts'],
  },
  {
    file: 'orchestrator/src/run/run-bootstrap.ts',
    allowed: ['./run-alive.ts'],
  },
  {
    file: 'orchestrator/src/run/run-coordinator-log.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../filesystem-identity-plan.ts',
      '../route/routing-refusal.ts',
      '../../../shared/secret-shaped.ts',
      './run-artifacts.ts',
    ],
  },
  {
    file: 'orchestrator/src/run/run-terminal-premature.ts',
    allowed: ['../contract/contract.ts', '../evidence/premature-final.ts', '../outcome.ts'],
  },
] as const

export const runModuleBoundarySpecs = [
  {
    name: 'run-coordinator-log-boundary',
    file: 'orchestrator/src/run/run-coordinator-log.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../filesystem-identity-plan.ts',
      '../route/routing-refusal.ts',
      '../../../shared/secret-shaped.ts',
      './run-artifacts.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep coordinator diagnostics independent of run lifecycle policy and database state.',
  },
  {
    name: 'run-diff-boundary',
    file: 'orchestrator/src/run/run-diff.ts',
    allowed: [
      '../../../shared/brand.ts',
      'node:fs',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep run diff independent of run control, transports, routing, the CLI, and worktrees by value.',
  },
] as const
