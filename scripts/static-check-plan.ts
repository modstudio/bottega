type WorkerDecision = { run: true } | { run: false; reason: string }
const HOSTED_REFUSAL_TEXT_CHECK = 'scripts/check-hosted-refusal-text.ts'

export type StaticCheckDeclaration = {
  name: string
  argv: (input: { root: string; qualityBase: string }) => string[]
  category?: string
  reportsRemaining?: boolean
  worker: WorkerDecision
  workerArgv?: (root: string) => string[]
}

const run = { run: true } as const
const omit = (reason: string): WorkerDecision => ({ run: false, reason })
const broadInventory = (subject: string) =>
  omit(`repository-wide ${subject} inventory is not change-scoped`)
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
    name: 'Biome',
    argv: ({ root }) => [`${root}node_modules/.bin/biome`, 'ci', '.'],
    worker: run,
    workerArgv: (root) => [
      `${root}node_modules/.bin/biome`,
      'ci',
      '--changed',
      '--since=origin/main',
      '--no-errors-on-unmatched',
    ],
  },
  {
    name: 'project checks',
    argv: ({ root }) => ['bun', `${root}orchestrator/scripts/check-projects.ts`],
    worker: omit("inspects the machine's project register rather than the worker change"),
  },
  {
    name: 'orchestrator identity inventory',
    argv: ({ root, qualityBase }) => [
      'bun',
      `${root}scripts/check-identity-inventory.ts`,
      qualityBase,
    ],
    worker: broadInventory('identity'),
  },
  {
    name: 'SQL literal schema',
    argv: ({ root }) => ['bun', `${root}scripts/check-sql-literal-schema.ts`],
    worker: broadInventory('SQL literal'),
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
  script('scripts/check-cascade-preservation.ts', broadInventory('foreign-key cascade')),
  script('scripts/check-postgres-migrations.ts', omit('needs a database')),
  script('scripts/check-postgres-array-bindings.ts', broadInventory('Postgres array binding')),
  script('scripts/check-record-jsonb-string-checks.ts', broadInventory('record JSONB constraint')),
  script('scripts/check-outbox-payload-contracts.ts', broadInventory('outbox payload')),
  script('scripts/check-record-migrations-apply.ts', omit('needs a database')),
  script(
    'scripts/check-bun-serve-timeout.ts',
    omit('exercises the Bun server runtime rather than changed files'),
  ),
  script(
    'scripts/check-hosted-hub-server-boundary.ts',
    broadInventory('hosted hub server boundary'),
  ),
  script(HOSTED_REFUSAL_TEXT_CHECK, broadInventory('hosted refusal text')),
  script('scripts/check-docker-workspaces.ts', omit('needs Docker workspace inspection')),
  script('scripts/check-hub-packages.ts', broadInventory('hub package boundary')),
  script('scripts/check-hub-ui-styles.ts', broadInventory('hub UI style')),
  script('scripts/check-storybook.ts', omit('needs the Storybook build surface')),
  script('scripts/check-architecture.ts', run, { extra: (qualityBase) => [qualityBase] }),
  script('scripts/check-review-boundary.ts', broadInventory('review boundary')),
  script('scripts/check-outcome-boundary.ts', broadInventory('outcome boundary')),
  script('scripts/check-contract-boundary.ts', broadInventory('contract boundary')),
  script('scripts/check-evidence-boundary.ts', broadInventory('evidence boundary')),
  script('scripts/check-git-environment-spawn.ts', broadInventory('Git environment spawn')),
  script('scripts/check-self-spawn.ts', broadInventory('self-spawn')),
  script('scripts/check-source-root.ts', broadInventory('source-root')),
  script('scripts/check-launchd-templates.ts', omit('validates machine launchd templates')),
  script(
    'scripts/check-hook-binary.ts',
    omit('validates installed hook binaries outside the worker tree'),
  ),
  script('scripts/check-gitleaks.ts', omit('needs the repository secret-scanning toolchain')),
  script('scripts/check-write-transaction-site.ts', broadInventory('write-transaction call-site')),
  script(
    'scripts/check-branch-ref-mutation-site.ts',
    broadInventory('branch-ref mutation call-site'),
  ),
  script('scripts/check-command-descriptions.ts', broadInventory('command description')),
  script('scripts/reference.ts', broadInventory('command reference')),
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
    worker: omit('the worker runs the narrower file and cognitive ratchets'),
  },
  script('scripts/check-test-fixtures.ts', broadInventory('test fixture')),
  script('scripts/check-test-placement.ts', run),
  script('scripts/check-test-reach.ts', broadInventory('test reach'), {
    extra: (qualityBase) => [qualityBase],
  }),
  script('scripts/check-test-spawns.ts', broadInventory('test process-spawn')),
  script('scripts/check-dead-code.ts', run, {
    extra: (qualityBase) => [qualityBase],
    category: 'unused-exports',
    reportsRemaining: true,
  }),
  script('scripts/check-brand.ts', run),
  script('scripts/check-legacy-names.ts', run),
  script('scripts/check-doc-editor-rich-style.ts', broadInventory('document-editor style')),
  script('scripts/check-harness-mirror.ts', omit('compares the external harness mirror')),
  script('scripts/check-canon-drift.ts', omit('compares tree canon with the machine doc store')),
  script(
    'scripts/check-workflow-drift.ts',
    omit('compares tree workflows with the machine doc store'),
  ),
  script('scripts/check-workflow-tree.ts', broadInventory('workflow tree')),
  script('scripts/check-ci-workflow.ts', broadInventory('CI workflow')),
  script('scripts/generate-recipe-schema.ts', broadInventory('recipe schema'), {
    extra: () => ['--check'],
  }),
  script('orchestrator/scripts/check-pack-budget.ts', omit('compiles machine-backed canon packs')),
  script('orchestrator/scripts/check-canon-lint.ts', run),
  script('scripts/quality/check-test-substance.ts', run, {
    extra: (qualityBase) => [qualityBase],
    category: 'test-substance',
  }),
]

export function staticCheckPlan(): readonly StaticCheckDeclaration[] {
  return STATIC_CHECKS
}

// The declaration is also consumed here so its test seam is a production-used export.
if (staticCheckPlan().length === 0) throw new Error('the static check plan must not be empty')
