import { PLATFORM_SLUG } from '../shared/brand.ts'

export const cliConcernEntries = [
  'hub/src/cli.ts',
  'hub/src/hosted-tasks.ts',
  'hub/src/task-hosted-record.ts',
  'hub/src/task-print.ts',
  'orchestrator/src/ask/ask-proxy.ts',
  'orchestrator/src/ask/worker-record-read-client.ts',
  'orchestrator/src/check/check-attribution.ts',
  'orchestrator/src/check/check-strict-schema.ts',
  'orchestrator/src/cli/orch.ts',
  'orchestrator/src/run/exec.ts',
  'orchestrator/src/workflow/workflow-text.ts',
  'orchestrator/src/workflow/workflow-text-commands.ts',
  'retrieval/src/search-cli.ts',
] as const

export const cliModules = [
  {
    file: `cli/${PLATFORM_SLUG}.ts`,
    allowed: [
      ...cliConcernEntries,
      'shared/commander-public-path.ts',
      'shared/install-root.ts',
      'cli/dispatch.ts',
      'cli/task-read-adapter.ts',
      'cli/worker-record-read.ts',
    ],
  },
  {
    file: 'cli/worker-record-read.ts',
    allowed: [
      'hub/src/hosted-tasks.ts',
      'hub/src/task-hosted-record.ts',
      'hub/src/task-print.ts',
      'orchestrator/src/ask/worker-record-read-client.ts',
      'orchestrator/src/workflow/workflow-text.ts',
      'orchestrator/src/workflow/workflow-text-commands.ts',
      'shared/brand.ts',
      'shared/caller-classification.ts',
      'shared/worker-read-tools.ts',
    ],
  },
  {
    file: 'cli/task-read-adapter.ts',
    allowed: [
      'node:os',
      'hub/src/db.ts',
      'hub/src/project-register-reader.ts',
      'hub/src/task.ts',
      'hub/src/task-document.ts',
      'hub/src/projects.ts',
      'orchestrator/src/sandbox/confinement-probe-task-port.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/database/migrations.ts',
      'orchestrator/src/project/project-list-json.ts',
      'orchestrator/src/project/project-read.ts',
      'orchestrator/src/project/project-registration.ts',
      'orchestrator/src/workflow/task-read-port.ts',
      'shared/orch-contract.ts',
      'shared/refusal.ts',
      'shared/state-directory.ts',
    ],
  },
  {
    file: 'cli/dispatch.ts',
    allowed: [
      'shared/brand.ts',
      'shared/commander-public-path.ts',
      'shared/self-spawn.ts',
      'shared/storage-lifecycle.ts',
      'cli/legacy-calls.ts',
      'cli/routes.ts',
      'cli/storage-report.ts',
    ],
  },
  {
    file: 'cli/legacy-calls.ts',
    allowed: ['node:fs', 'node:path', 'shared/brand.ts', 'shared/state-directory.ts'],
  },
  {
    file: 'cli/storage-report.ts',
    allowed: ['shared/storage-lifecycle.ts'],
  },
  { file: 'cli/routes.ts', allowed: ['shared/task-close-exit.ts'] },
  {
    file: 'cli/routes.test.ts',
    allowed: [
      'commander',
      'shared/brand.ts',
      'shared/cli-repeat-guard.ts',
      'shared/commander-public-path.ts',
      'hub/src/cli-program.ts',
      'orchestrator/src/cli/program.ts',
      'cli/dispatch.ts',
      'cli/routes.ts',
    ],
  },
] as const

export function concernIsolationRule(roots: readonly string[]) {
  return {
    name: 'concern-isolation',
    severity: 'error' as const,
    from: { path: `^(${roots.join('|')})/`, pathNot: ['^cli/'] },
    to: {
      path: `^(?!$1/|shared/)(${roots.join('|')})/`,
    },
  }
}

export function cliCompositionRule(
  roots: readonly string[],
  entries: readonly string[],
  exactPath: (path: string) => string,
) {
  return {
    name: 'cli-imports-only-concern-entries',
    severity: 'error' as const,
    from: {
      path: '^cli/',
      pathNot: ['^cli/routes\\.test\\.ts$', '^cli/task-read-adapter(?:\\.test)?\\.ts$'],
    },
    to: {
      path: `^(${roots.filter((root) => root !== 'cli').join('|')})/`,
      pathNot: entries.map(exactPath),
    },
  }
}

export function cliRouteInspectionRule(
  roots: readonly string[],
  exactPath: (path: string) => string,
) {
  return {
    name: 'cli-route-test-inspects-only-owner-programs',
    severity: 'error' as const,
    from: { path: '^cli/routes[.]test[.]ts$' },
    to: {
      path: `^(${roots.filter((root) => root !== 'cli').join('|')})/`,
      pathNot: [exactPath('hub/src/cli-program.ts'), exactPath('orchestrator/src/cli/program.ts')],
    },
  }
}
