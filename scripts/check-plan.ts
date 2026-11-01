import { ORCHESTRATOR_GATE_TEST_SELECTION } from '../orchestrator/test/gate-test-selection.ts'

const HOOKS_FOCUSED_FORM = {
  directory: 'orchestrator/hooks',
  argv: ['python3', '-m', 'unittest'],
} as const

export const CHECK_LEGS = [
  {
    name: 'cli',
    directory: 'cli',
    ciJob: 'cli',
    testDirectories: [],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: ['cli/tsconfig.json'],
    worker: { run: true },
    suite: [],
  },
  {
    name: 'orchestrator',
    directory: 'orchestrator',
    ciJob: 'orchestrator',
    testDirectories: ORCHESTRATOR_GATE_TEST_SELECTION.directories.map(({ reach }) => reach),
    testPatterns: [],
    excludedTestDirectories: ORCHESTRATOR_GATE_TEST_SELECTION.exclusions.flatMap((exclusion) =>
      'reachDirectory' in exclusion ? [exclusion.reachDirectory] : [],
    ),
    excludedTestPatterns: ORCHESTRATOR_GATE_TEST_SELECTION.exclusions.flatMap((exclusion) =>
      'reachPattern' in exclusion ? [exclusion.reachPattern] : [],
    ),
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: ['orchestrator/tsconfig.json'],
    worker: { run: true },
    suite: [{ argv: ['bun', 'run', 'test:gate'], unitTests: true }],
  },
  {
    name: 'orchestrator/hooks',
    directory: '.',
    ciJob: 'orchestrator-hooks',
    testDirectories: [],
    testPatterns: ['orchestrator/hooks/test_*.py'],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: null,
    typecheckConfigs: [],
    worker: { run: true },
    suite: [
      {
        argv: [
          'python3',
          '-m',
          'unittest',
          'discover',
          '-s',
          'orchestrator/hooks',
          '-p',
          'test_*.py',
        ],
        focused: HOOKS_FOCUSED_FORM,
        unitTests: true,
      },
    ],
  },
  {
    name: 'hub',
    directory: 'hub',
    ciJob: 'hub',
    testDirectories: ['hub'],
    testPatterns: [],
    excludedTestDirectories: ['hub/data'],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: ['hub/tsconfig.json'],
    worker: { run: true },
    suite: [
      { argv: ['bun', 'run', 'test'], unitTests: true },
      { argv: ['bun', 'run', '--cwd', 'site', 'test'], unitTests: true },
      { argv: ['bun', 'run', '--cwd', 'util', 'test'], unitTests: true },
    ],
  },
  {
    name: 'hub/data',
    directory: 'hub/data',
    ciJob: 'hub-data',
    testDirectories: ['hub/data'],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: ['hub/data/tsconfig.json'],
    worker: {
      run: false,
      reason: 'slow: 5.6s CPU in the gate (gate 5311)',
      evidence: '"bun run check"',
    },
    suite: [{ argv: ['bun', 'run', 'test'], unitTests: true }],
  },
  {
    name: 'hub/web',
    directory: 'hub/web',
    ciJob: 'hub-web',
    testDirectories: ['hub/web'],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: [
      'hub/web/tsconfig.json',
      'hub/ui/tsconfig.json',
      'hub/views/tsconfig.json',
      'hub/data/tsconfig.json',
      'hub/util/tsconfig.json',
      'hub/site/tsconfig.json',
    ],
    worker: {
      run: false,
      reason: 'slow: 24.0s CPU in the gate (gate 5311)',
      evidence: '"bun run check"',
    },
    suite: [
      { argv: ['bun', 'run', 'test'], unitTests: true },
      { argv: ['bun', 'run', 'build'], unitTests: false },
    ],
  },
  {
    name: 'hub/deploy/site',
    directory: 'hub/deploy/site',
    ciJob: 'hub-deploy-site',
    testDirectories: ['hub/deploy/site/src'],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: ['hub/deploy/site/tsconfig.json'],
    worker: { run: true },
    suite: [{ argv: ['bun', 'run', 'test'], unitTests: true }],
  },
  {
    name: 'retrieval',
    directory: 'retrieval',
    ciJob: 'retrieval',
    testDirectories: ['retrieval/src'],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck'],
    typecheckConfigs: ['retrieval/tsconfig.json'],
    worker: { run: true },
    suite: [{ argv: ['bun', 'run', 'test'], unitTests: true }],
  },
  {
    name: 'shared',
    directory: '.',
    ciJob: 'shared',
    testDirectories: ['shared'],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck:shared'],
    typecheckConfigs: ['shared/tsconfig.json'],
    worker: { run: true },
    suite: [
      {
        argv: ['bun', 'test', './shared'],
        unitTests: true,
      },
    ],
  },
  {
    name: 'scripts',
    directory: '.',
    ciJob: null,
    testDirectories: [],
    testPatterns: [],
    excludedTestDirectories: [],
    excludedTestPatterns: [],
    typecheck: ['bun', 'run', 'typecheck:scripts'],
    typecheckConfigs: ['scripts/tsconfig.json'],
    worker: {
      run: false,
      reason: 'slow: 13.8s CPU in the gate (gate 5311)',
      evidence: '"bun run check"',
    },
    suite: [],
  },
] as const

export const ROOT_TEST_FILES = [
  'scripts/check-hook-binary.test.ts',
  'scripts/architecture-cruise.test.ts',
  'scripts/architecture-hub-data.test.ts',
  'scripts/architecture-ui-layers.test.ts',
  'scripts/architecture-undeclared-modules.test.ts',
  'scripts/architecture-violation-baseline.test.ts',
  'scripts/check-hub-ui-styles.test.ts',
  'scripts/check-bun-serve-timeout.test.ts',
  'scripts/check-launchd-templates.test.ts',
  'scripts/check-record-project-space-ownership.test.ts',
  'scripts/check-machine-state.test.ts',
  'scripts/check-legacy-names.test.ts',
  'scripts/check-docker-workspaces.test.ts',
  'scripts/check-dependency-audit.test.ts',
  'scripts/check-runtime.test.ts',
  'scripts/static-check-plan.test.ts',
  'scripts/check-ci-workflow.test.ts',
  'scripts/check-storybook.test.ts',
  'scripts/check-outcome.test.ts',
  'scripts/check-gitleaks-plan.test.ts',
  'scripts/check-cascade-preservation.test.ts',
  'scripts/identity-inventory.test.ts',
  'scripts/check-outbox-payload-contracts.test.ts',
  'scripts/record-migration-bounds.test.ts',
  'scripts/record-migration-failure.test.ts',
  'scripts/record-migration-force-rls-lifts.test.ts',
  'scripts/record-migration-set.test.ts',
  'scripts/check-record-rehearsal.test.ts',
  'scripts/record-rehearse.test.ts',
  'scripts/postgres-migration-rls.test.ts',
  'scripts/check-test-placement.test.ts',
  'scripts/check-test-reach.test.ts',
  'scripts/check-typecheck-reach.test.ts',
  'orchestrator/src/postgres/postgres-migrate.test.ts',
  'orchestrator/src/postgres/postgres-migrate-routing-evidence-sequence.test.ts',
  'orchestrator/src/record/record-pool-postgres.test.ts',
  'orchestrator/src/postgres/postgres-migrate-stranded-runs.test.ts',
  'orchestrator/src/postgres/migration-failure.test.ts',
  'orchestrator/src/postgres/migration-notices.test.ts',
  'orchestrator/src/ratchet/biome-adapter.test.ts',
  'orchestrator/src/ratchet/ratchet-plan.test.ts',
  'scripts/check-file-ceiling.test.ts',
  'scripts/check-git-environment-spawn.test.ts',
  'scripts/check-git-path-list.test.ts',
  'scripts/command-descriptions.test.ts',
  'scripts/command-reference.test.ts',
  'scripts/check-cognitive-ceiling.test.ts',
  'scripts/check-harness-mirror.test.ts',
  'scripts/check-canon-drift.test.ts',
  'scripts/check-workflow-drift.test.ts',
  'scripts/check-workflow-tree.test.ts',
  'scripts/check-postgres-array-bindings.test.ts',
  'scripts/check-record-jsonb-string-checks.test.ts',
  'scripts/check-record-sql-pool.test.ts',
  'scripts/check-outbox-serialization.test.ts',
  'orchestrator/scripts/time-wait-guard.test.ts',
  'scripts/check-self-spawn.test.ts',
  'scripts/check-source-root.test.ts',
  'scripts/build-binary.test.ts',
  'scripts/release-support.test.ts',
  'scripts/build-release-artifacts.test.ts',
  'scripts/publish-release.test.ts',
  'cli/dispatch.test.ts',
  'cli/routes.test.ts',
  'cli/legacy-calls.test.ts',
  'scripts/quality/dead-code.test.ts',
  'scripts/architecture.test.ts',
  'scripts/architecture-hub-packages.test.ts',
  'scripts/import-scanner.test.ts',
  'scripts/quality/test-timing-decision.test.ts',
  'scripts/quality/test-spawns-decision.test.ts',
  'scripts/affected-tests.test.ts',
  'scripts/test-focused.test.ts',
  'scripts/test-preload.test.ts',
  'scripts/check-sql-literal-schema.test.ts',
  'scripts/check-hosted-sql-schema.test.ts',
] as const

/**
 * The repo-relative test glob a suite's own command collects: unittest
 * discovery's `-s <dir>` joined with its `-p <pattern>`. check-test-reach counts
 * every file this names as reached, and it is derived from the command rather
 * than declared beside it, so the reach and the command cannot disagree.
 */
export function suiteReachPatterns(argv: readonly string[]): string[] {
  const flag = (name: string) => {
    const index = argv.indexOf(name)
    return index < 0 ? undefined : argv[index + 1]
  }
  const directory = flag('-s')
  const pattern = flag('-p')
  if (!directory || !pattern) {
    throw new Error(`a CI-only suite argv must carry -s <dir> and -p <pattern>: ${argv.join(' ')}`)
  }
  return [`${directory}/${pattern}`]
}

/**
 * A test suite that only CI runs, declared once with the command it runs; its
 * reach is derived from that command, not declared beside it. The heartbeat
 * decision suite keeps its pure cases in the gate leg, and the cases that drive
 * orch-heartbeat.sh and its children are process tests, so this job runs them
 * instead. The gate's unittest discovery cannot exclude a file by pattern, so
 * the `process_` name is the exclusion.
 */
export const CI_ONLY_SUITES = [
  {
    job: 'orchestrator-hooks-process',
    argv: [
      'python3',
      '-m',
      'unittest',
      'discover',
      '-s',
      'orchestrator/hooks',
      '-p',
      'process_*.py',
    ],
    focused: HOOKS_FOCUSED_FORM,
  },
].map((suite) => ({ ...suite, testPatterns: suiteReachPatterns(suite.argv) }))

/**
 * CI-only process checks that are intentionally outside the in-process local
 * gate, including the job of every declared CI-only suite.
 */
export const CI_ONLY_JOBS = [
  'postgres',
  'record-rehearsal',
  'hub-ui-stories',
  'hub-web-smoke',
  ...CI_ONLY_SUITES.map((suite) => suite.job),
] as const

export const STATIC_OMIT_GROUPS = {
  'machine-only': {
    reason: "CI runners do not have this machine's project register and local stores",
    checks: ['project checks', 'scripts/check-canon-drift.ts', 'scripts/check-workflow-drift.ts'],
  },
  secrets: {
    reason: 'the CI secrets job runs the same gitleaks scan in its container',
    checks: ['scripts/check-gitleaks.ts'],
  },
} as const
