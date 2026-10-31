import { parseNameStatus, untrackedChanges } from '../shared/change-view.ts'

type WorkerDecision = { run: true } | { run: false; reason: string }
const HOSTED_REFUSAL_TEXT_CHECK = 'scripts/check-hosted-refusal-text.ts'
export const BIOME_CHECK_NAME = 'Biome'

export type StaticCheckDeclaration = {
  name: string
  argv: (input: { root: string; qualityBase: string }) => string[]
  category?: string
  reportsRemaining?: boolean
  worker: WorkerDecision
  workerArgv?: (input: { root: string; files: readonly string[] }) => string[]
}

const run = { run: true } as const
const omit = (reason: string): WorkerDecision => ({ run: false, reason })

/** Select present paths from a NUL-separated worktree change view, once and in stable order. */
export function workerBiomeFiles(input: { nameStatus: string; untracked: string }): string[] {
  const tracked = parseNameStatus(input.nameStatus)
    .filter((entry) => entry.status !== 'D')
    .map((entry) => entry.path)
  const untracked = untrackedChanges(input.untracked, new Map()).entries.map((entry) => entry.path)
  return [...new Set([...tracked, ...untracked])].sort()
}

const script = (
  name: string,
  worker: WorkerDecision,
  options: {
    extra?: (qualityBase: string) => string[]
    category?: string
    reportsRemaining?: boolean
  } = {},
): StaticCheckDeclaration => ({
  name,
  argv: ({ root, qualityBase }) => [
    'bun',
    `${root}${name}`,
    ...(options.extra?.(qualityBase) ?? []),
  ],
  ...(options.category ? { category: options.category } : {}),
  ...(options.reportsRemaining ? { reportsRemaining: true } : {}),
  worker,
})

/** The full static gate and worker subset, declared once and safe to import. */
const STATIC_CHECKS: readonly StaticCheckDeclaration[] = [
  {
    name: BIOME_CHECK_NAME,
    argv: ({ root }) => [`${root}node_modules/.bin/biome`, 'ci', '.'],
    worker: run,
    workerArgv: ({ root, files }) => [
      `${root}node_modules/.bin/biome`,
      'ci',
      '--no-errors-on-unmatched',
      ...files,
    ],
  },
  {
    name: 'project checks',
    argv: ({ root }) => ['bun', `${root}orchestrator/scripts/check-projects.ts`],
    worker: omit("reads the machine's project register; slow: 4.1s CPU in the gate"),
  },
  {
    name: 'orchestrator identity inventory',
    argv: ({ root, qualityBase }) => [
      'bun',
      `${root}scripts/check-identity-inventory.ts`,
      qualityBase,
    ],
    worker: run,
  },
  {
    name: 'SQL literal schema',
    argv: ({ root }) => ['bun', `${root}scripts/check-sql-literal-schema.ts`],
    worker: run,
  },
  {
    name: 'hosted SQL schema',
    argv: ({ root }) => ['bun', `${root}scripts/check-hosted-sql-schema.ts`],
    worker: omit('needs a database'),
  },
  script(
    'scripts/check-machine-state.ts',
    omit('inspects machine-state paths outside the worker tree'),
  ),
  script('scripts/check-cascade-preservation.ts', omit('slow: 3.2s CPU in the gate')),
  script('scripts/check-postgres-migrations.ts', omit('needs a database')),
  script('scripts/check-postgres-array-bindings.ts', run),
  script('scripts/check-record-jsonb-string-checks.ts', run),
  script('scripts/check-outbox-payload-contracts.ts', run),
  script('scripts/check-record-migrations-apply.ts', omit('needs a database')),
  script('scripts/check-bun-serve-timeout.ts', run),
  script('scripts/check-hosted-hub-server-boundary.ts', run),
  script(HOSTED_REFUSAL_TEXT_CHECK, run),
  script('scripts/check-docker-workspaces.ts', run),
  script('scripts/check-hub-packages.ts', run),
  script('scripts/check-hub-ui-styles.ts', run),
  script('scripts/check-storybook.ts', run),
  script('scripts/check-architecture.ts', run, { extra: (qualityBase) => [qualityBase] }),
  script('scripts/check-review-boundary.ts', run),
  script('scripts/check-outcome-boundary.ts', run),
  script('scripts/check-contract-boundary.ts', run),
  script('scripts/check-evidence-boundary.ts', run),
  script('scripts/check-git-environment-spawn.ts', run),
  script('scripts/check-git-path-list.ts', run),
  script('scripts/check-self-spawn.ts', run),
  script('scripts/check-source-root.ts', run),
  script(
    'scripts/check-launchd-templates.ts',
    omit('reads machine configuration outside the worker tree'),
  ),
  script(
    'scripts/check-hook-binary.ts',
    omit('validates installed hook binaries outside the worker tree'),
  ),
  script('scripts/check-gitleaks.ts', omit('needs the installed gitleaks binary')),
  script('scripts/check-write-transaction-site.ts', run),
  script('scripts/check-branch-ref-mutation-site.ts', run),
  script('scripts/check-command-descriptions.ts', run),
  script('scripts/reference.ts', run),
  script('scripts/check-file-ceiling.ts', run, {
    category: 'file-length',
    reportsRemaining: true,
  }),
  script('scripts/check-cognitive-ceiling.ts', run, {
    extra: (qualityBase) => [qualityBase],
    category: 'cognitive-complexity',
    reportsRemaining: true,
  }),
  {
    name: 'function length and naming ratchet',
    argv: ({ root, qualityBase }) => [
      'bun',
      `${root}orchestrator/src/cli/orch.ts`,
      'ratchet',
      '--format',
      'biome',
      qualityBase,
      '--support',
      'biome.jsonc',
      '--support',
      'hub/web/lint',
      '--',
      `${root}node_modules/.bin/biome`,
      'lint',
      '--vcs-use-ignore-file=false',
      '--only=complexity/noExcessiveLinesPerFunction',
      '--only=style/useNamingConvention',
      '--reporter=json',
      '{files}',
    ],
    worker: run,
  },
  script('scripts/check-test-fixtures.ts', run),
  script('scripts/check-test-placement.ts', run),
  script('scripts/check-test-reach.ts', run, {
    extra: (qualityBase) => [qualityBase],
  }),
  script('scripts/check-typecheck-reach.ts', run),
  script('scripts/check-test-spawns.ts', run),
  script('scripts/check-dead-code.ts', run, {
    extra: (qualityBase) => [qualityBase],
    category: 'unused-exports',
    reportsRemaining: true,
  }),
  script('scripts/check-brand.ts', run),
  script('scripts/check-legacy-names.ts', run),
  script('scripts/check-doc-editor-rich-style.ts', run),
  script('scripts/check-harness-mirror.ts', run),
  script('scripts/check-canon-drift.ts', omit('compares tree canon with the machine doc store')),
  script(
    'scripts/check-workflow-drift.ts',
    omit('compares tree workflows with the machine doc store'),
  ),
  script('scripts/check-workflow-tree.ts', run),
  script('scripts/check-ci-workflow.ts', run),
  script('scripts/generate-recipe-schema.ts', run, {
    extra: () => ['--check'],
  }),
  script(
    'orchestrator/scripts/check-pack-budget.ts',
    omit('compiles packs from the machine doc store; slow: 7.5s CPU in the gate'),
  ),
  script('orchestrator/scripts/check-canon-lint.ts', run),
  script('scripts/quality/check-test-substance.ts', run, {
    extra: (qualityBase) => [qualityBase],
    category: 'test-substance',
  }),
]

export function staticCheckPlan(): readonly StaticCheckDeclaration[] {
  return STATIC_CHECKS
}

type WorkerLegDeclaration = {
  name: string
  typecheck: unknown
  worker: WorkerDecision
}

export type WorkerOmission = { name: string; reason: string }

/** Project the shared gate declaration into the worker's commands and complete omission report. */
export function workerCheckProjection<TLeg extends WorkerLegDeclaration>(
  staticChecks: readonly StaticCheckDeclaration[],
  legs: readonly TLeg[],
): {
  biome: StaticCheckDeclaration
  typecheckLegs: TLeg[]
  staticChecks: StaticCheckDeclaration[]
  omitted: WorkerOmission[]
} {
  const biomeCandidates = staticChecks.filter((check) => check.workerArgv !== undefined)
  if (biomeCandidates.length !== 1) {
    throw new Error('the worker check must declare exactly one worker-specific Biome command')
  }
  const biome = biomeCandidates[0]!
  const typecheckLegs = legs.filter((leg) => leg.typecheck !== null && leg.worker.run)
  const workerStaticChecks = staticChecks.filter((check) => check !== biome && check.worker.run)
  const omitted: WorkerOmission[] = [
    {
      name: 'test suites',
      reason: 'worker check runs no test suites; bun run check runs them',
    },
    ...legs.flatMap((leg) =>
      leg.typecheck !== null && leg.worker.run
        ? []
        : [
            {
              name: `${leg.name} typecheck`,
              reason: leg.worker.run ? 'has no typecheck command' : leg.worker.reason,
            },
          ],
    ),
    ...staticChecks.flatMap((check) =>
      check.worker.run ? [] : [{ name: check.name, reason: check.worker.reason }],
    ),
  ]
  return { biome, typecheckLegs, staticChecks: workerStaticChecks, omitted }
}
