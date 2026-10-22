export const runModuleSpecs = [
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
    allowed: ['../agent/agents.ts', '../transport/vendor-usage.ts'],
  },
  {
    file: 'orchestrator/src/run/run-mcp-mode.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/run-number.ts',
    allowed: ['bun:sqlite', '../database/entity-number.ts'],
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
    file: 'orchestrator/src/run/run-bootstrap.ts',
    allowed: ['./run-alive.ts'],
  },
  {
    file: 'orchestrator/src/run/run-coordinator-log.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../filesystem-identity-plan.ts',
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
