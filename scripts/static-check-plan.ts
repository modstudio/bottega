import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseNameStatus, untrackedChanges } from '../shared/change-view.ts'

type WorkerOmissionBase = { run: false; reason: string; evidence: string }
type WorkerSubjects =
  | { subjects: readonly `${string}/`[]; noSubjects?: never }
  | { noSubjects: string; subjects?: never }
type WorkerDecision = { run: true } | (WorkerOmissionBase & WorkerSubjects)
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

/**
 * What the ratchet's base-side mirror must carry for every lint plugin biome.jsonc loads, at the
 * root or under an override: the plugin's directory, or the plugin file itself when it sits at
 * the root. Without them biome refuses to start there and every finding reads as new.
 */
export function biomePluginSupport(config: unknown): string[] {
  const root = config as { plugins?: unknown; overrides?: unknown } | null
  const overrides = Array.isArray(root?.overrides) ? root.overrides : []
  const sections = [root, ...overrides] as ({ plugins?: unknown } | null)[]
  const support = sections.flatMap((section) =>
    Array.isArray(section?.plugins) ? section.plugins.flatMap(pluginSupport) : [],
  )
  return [...new Set(support)].sort()
}

function pluginSupport(plugin: unknown): string[] {
  const path = typeof plugin === 'string' ? plugin : (plugin as { path?: unknown } | null)?.path
  if (typeof path !== 'string') return []
  const name = path.replace(/^\.\//, '')
  const directory = dirname(name)
  return [directory === '.' ? name : directory]
}

const readBiomeConfig = (root: string): unknown =>
  Bun.JSONC.parse(readFileSync(`${root}biome.jsonc`, 'utf8'))

const omit = (reason: string, evidence: string, subjects: WorkerSubjects): WorkerDecision => ({
  run: false,
  reason,
  evidence,
  ...subjects,
})

export type WorkerOmissionEvidence =
  | { kind: 'run'; runId: string }
  | { kind: 'command'; command: string }
  | { kind: 'citation'; path: string; symbol: string }
  | { kind: 'invalid' }

/** Classify the recorded support for omitting a check from the worker gate. */
export function classifyWorkerOmissionEvidence(evidence: string): WorkerOmissionEvidence {
  const runEvidence = /^run (\d+)$/.exec(evidence)
  if (runEvidence) return { kind: 'run', runId: runEvidence[1]! }

  const commandEvidence = /^"([^"\r\n]+)"$/.exec(evidence)
  if (commandEvidence) return { kind: 'command', command: commandEvidence[1]! }

  const citationEvidence = /^([^:\r\n]+):([A-Za-z_$][\w$]*)$/.exec(evidence)
  if (citationEvidence) {
    const path = citationEvidence[1]!
    const repositoryRelative =
      !path.startsWith('/') && !path.split('/').some((part) => part === '.' || part === '..')
    if (repositoryRelative) return { kind: 'citation', path, symbol: citationEvidence[2]! }
  }

  return { kind: 'invalid' }
}

function workerOmissionReason(decision: { reason: string; evidence: string }): string {
  if (classifyWorkerOmissionEvidence(decision.evidence).kind === 'invalid') {
    throw new Error(
      `worker omission evidence '${decision.evidence}' is not a run id, a quoted command or a path:symbol citation; cite one in scripts/static-check-plan.ts or scripts/check-plan.ts`,
    )
  }
  return `${decision.reason} (evidence: ${decision.evidence})`
}

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
    worker: omit(
      'slow: 4.2s CPU under the worker check; the landing gate runs it, and CI omits it as machine-only',
      'run 25620',
      {
        noSubjects: "it gates the operator's live store snapshot, which a worker cannot open",
      },
    ),
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
    worker: omit(
      'slow: 3.8s CPU under the worker check; the landing gate and CI run it',
      'run 25620',
      { subjects: ['shared/record/migrations/'] },
    ),
  },
  script('scripts/check-machine-state.ts', run),
  script(
    'scripts/check-cascade-preservation.ts',
    omit('slow: 2.7s CPU under the worker check; the landing gate and CI run it', 'run 25620', {
      subjects: ['orchestrator/migrations/'],
    }),
  ),
  script(
    'scripts/check-postgres-migrations.ts',
    omit('slow: 2.5s CPU under the worker check; the landing gate and CI run it', 'run 25620', {
      subjects: ['shared/record/migrations/'],
    }),
  ),
  script('scripts/check-record-migration-force-rls-lifts.ts', run),
  script('scripts/check-record-trigger-bypass.ts', run),
  script('scripts/check-space-teardown-tables.ts', run),
  script('scripts/check-postgres-array-bindings.ts', run),
  script('scripts/check-record-jsonb-string-checks.ts', run),
  script('scripts/check-record-sql-pool.ts', run),
  script('scripts/check-outbox-serialization.ts', run),
  script('scripts/check-outbox-insert-site.ts', run),
  script('scripts/check-outbox-payload-contracts.ts', run),
  script(
    'scripts/check-record-migrations-apply.ts',
    omit('slow: 2.3s CPU under the worker check; the landing gate and CI run it', 'run 25620', {
      subjects: ['shared/record/migrations/'],
    }),
  ),
  script('scripts/check-bun-serve-timeout.ts', run),
  script('scripts/check-bun-versions.ts', run),
  script('scripts/check-hosted-hub-server-boundary.ts', run),
  script(HOSTED_REFUSAL_TEXT_CHECK, run),
  script('scripts/check-refusal-remedy.ts', run),
  script('scripts/check-remedy-text.ts', run),
  script('scripts/check-secret-shaped-redaction.ts', run),
  script('scripts/check-docker-workspaces.ts', run),
  script('scripts/check-hosted-memory.ts', run),
  script('scripts/check-hub-packages.ts', run),
  script('scripts/check-hub-ui-styles.ts', run),
  script('scripts/check-storybook.ts', run),
  script('scripts/check-architecture.ts', run, { extra: (qualityBase) => [qualityBase] }),
  script('scripts/check-review-boundary.ts', run),
  script('scripts/check-outcome-boundary.ts', run),
  script('scripts/check-contract-boundary.ts', run),
  script('scripts/check-evidence-boundary.ts', run),
  script('scripts/check-raw-start.ts', run),
  script('scripts/check-main-checkout-moves.ts', run),
  script('scripts/check-active-space-moves.ts', run),
  script('scripts/check-git-path-list.ts', run),
  script('scripts/check-self-spawn.ts', run),
  script('scripts/check-unchecked-exits.ts', run),
  script('scripts/check-source-root.ts', run),
  script('scripts/check-install-paths.ts', run),
  script('scripts/check-rehearsal-image-imports.ts', run),
  script('scripts/check-launchd-templates.ts', run),
  script('scripts/check-hook-binary.ts', run),
  script('scripts/check-gitleaks.ts', run),
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
      ...biomePluginSupport(readBiomeConfig(root)).flatMap((path) => ['--support', path]),
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
  script('scripts/check-focused-test-routing.ts', run),
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
  script(
    'scripts/check-canon-drift.ts',
    omit(
      'a worker cannot write the doc store, so its canon edit always differs from the store',
      'shared/store-access.ts:decideStoreAccess',
      { noSubjects: 'a worker cannot write the doc store, so the check always differs' },
    ),
  ),
  script(
    'scripts/check-workflow-drift.ts',
    omit(
      'a worker cannot write the doc store, so its workflow step edit always differs from the store',
      'shared/store-access.ts:decideStoreAccess',
      { noSubjects: 'a worker cannot write the doc store, so the check always differs' },
    ),
  ),
  script('scripts/check-workflow-tree.ts', run),
  script('scripts/check-ci-workflow.ts', run),
  script('scripts/generate-recipe-schema.ts', run, {
    extra: () => ['--check'],
  }),
  script(
    'orchestrator/scripts/check-pack-budget.ts',
    omit('slow: 6.3s CPU under the worker check; the landing gate and CI run it', 'run 25620', {
      noSubjects:
        "it compiles packs against the operator's live store snapshot, which a worker cannot open",
    }),
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
export type ForcedWorkerCheck = { name: string; subject: string; file: string }

function forcedWorkerChecks(
  declarations: readonly { name: string; worker: WorkerDecision }[],
  changedFiles: readonly string[],
  name: (declaration: { name: string }) => string = (declaration) => declaration.name,
  preferSpecificSubject = false,
): ForcedWorkerCheck[] {
  const omitted = declarations.filter(
    (declaration): declaration is { name: string; worker: WorkerOmissionBase & WorkerSubjects } =>
      !declaration.worker.run,
  )
  const sortedFiles = [...changedFiles].sort()
  return omitted.flatMap((declaration): ForcedWorkerCheck[] => {
    if (declaration.worker.subjects === undefined) return []
    for (const subject of declaration.worker.subjects) {
      const file = sortedFiles.find((candidate) => {
        if (!candidate.startsWith(subject)) return false
        return (
          !preferSpecificSubject ||
          !omitted.some(
            (other) =>
              other !== declaration &&
              other.worker.subjects?.some(
                (otherSubject) =>
                  otherSubject.length > subject.length && candidate.startsWith(otherSubject),
              ),
          )
        )
      })
      if (file) return [{ name: name(declaration), subject, file }]
    }
    return []
  })
}

/** Project the shared gate declaration into the worker's commands and complete omission report. */
export function workerCheckProjection<TLeg extends WorkerLegDeclaration>(
  staticChecks: readonly StaticCheckDeclaration[],
  legs: readonly TLeg[],
  changedFiles: readonly string[],
): {
  biome: StaticCheckDeclaration
  typecheckLegs: TLeg[]
  staticChecks: StaticCheckDeclaration[]
  omitted: WorkerOmission[]
  forced: ForcedWorkerCheck[]
} {
  const biomeCandidates = staticChecks.filter((check) => check.workerArgv !== undefined)
  if (biomeCandidates.length !== 1) {
    throw new Error('the worker check must declare exactly one worker-specific Biome command')
  }
  const biome = biomeCandidates[0]!
  const forcedLegs = forcedWorkerChecks(legs, changedFiles, (leg) => `${leg.name} typecheck`, true)
  const forcedStaticChecks = forcedWorkerChecks(staticChecks, changedFiles)
  const forced = [...forcedLegs, ...forcedStaticChecks]
  const forcedLegNames = new Set(forcedLegs.map((check) => check.name.replace(/ typecheck$/, '')))
  const forcedStaticCheckNames = new Set(forcedStaticChecks.map((check) => check.name))
  const runsLegInWorker = (leg: TLeg) => leg.worker.run || forcedLegNames.has(leg.name)
  const typecheckLegs = legs.filter((leg) => leg.typecheck !== null && runsLegInWorker(leg))
  const runsInWorker = (check: StaticCheckDeclaration) =>
    check.worker.run || forcedStaticCheckNames.has(check.name)
  const workerStaticChecks = staticChecks.filter((check) => check !== biome && runsInWorker(check))
  const omitted: WorkerOmission[] = [
    {
      name: 'test suites',
      reason: 'worker check runs no test suites; bun run check runs them',
    },
    ...legs.flatMap((leg) =>
      leg.typecheck !== null && runsLegInWorker(leg)
        ? []
        : [
            {
              name: `${leg.name} typecheck`,
              reason: leg.worker.run
                ? 'has no typecheck command'
                : workerOmissionReason(leg.worker),
            },
          ],
    ),
    ...staticChecks.flatMap((check) =>
      runsInWorker(check)
        ? []
        : [
            {
              name: check.name,
              reason: workerOmissionReason(check.worker as WorkerOmissionBase),
            },
          ],
    ),
  ]
  return { biome, typecheckLegs, staticChecks: workerStaticChecks, omitted, forced }
}
