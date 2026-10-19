// concern: workflows
/** Pure built-in workflow definitions shared by local and hosted seed adapters. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { AutonomyStage, AutonomyValue } from './autonomy.ts'
import type { FloorKind } from './workflow-floor.ts'
import { expandWorkflowSteps } from './workflow-step-sequences.ts'

export const workflowSeeds = [
  {
    slug: 'fix-defect',
    revision: 5,
    definition: {
      title: 'Fix one reported defect',
      description: `A projection of the '${PLATFORM_SLUG} workflow fix-defect' command's coordinator for inspection.`,
      arguments: [{ name: 'key', required: true, description: 'The filed task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Resolve',
          default: true,
          steps: ['diagnose', 'fix', 'verify', 'blast-radius', 'triage', 'ship'],
        },
      ],
      steps: [
        {
          slug: 'diagnose',
          title: 'Diagnose',
          job: 'diagnose',
          autonomy: 'auto',
          gate: null,
          body: `Dispatch \`${PLATFORM_SLUG} run start diagnose --key {{key}} "Diagnose {{key}}: read it with {{tracker.actions.get}}, establish its cause with file:line evidence, and change nothing."\` and establish the cause before editing.`,
        },
        {
          slug: 'fix',
          title: 'Fix',
          job: 'issue-worker',
          autonomy: 'auto',
          gate: null,
          body: `Write the fix specification to a file: the recorded diagnosis, the before-fix reproduction, the fix to make, and what must remain true. Dispatch \`${PLATFORM_SLUG} run start issue-worker --key {{key}} --file <specification file>\`.`,
        },
        {
          slug: 'verify',
          title: 'Verify',
          job: null,
          autonomy: 'auto',
          gate: 'bun run check',
          body: 'Reproduce the original condition before and after the fix, then run the registered project gate.',
        },
        {
          slug: 'blast-radius',
          title: 'Review blast radius',
          job: 'review-lens',
          autonomy: 'auto',
          gate: null,
          body: `Use \`/absolute/path/to/main-checkout/bin/${PLATFORM_SLUG}\` from the main checkout, never a worktree's ./bin/${PLATFORM_SLUG}, whose access to the shared per-user store is read-only. Run \`/absolute/path/to/main-checkout/bin/${PLATFORM_SLUG} run start review-lens --review <fix-branch> --key {{key}} --lens issue-blast-radius "Review the fix for {{key}} for its blast radius."\`, where \`<fix-branch>\` is the branch \`${PLATFORM_SLUG} run result\` prints for the issue-worker run.`,
        },
        {
          slug: 'triage',
          title: 'Triage findings',
          job: null,
          autonomy: 'ask',
          gate: null,
          body: 'The architect triages every recorded finding before the issue can land.',
        },
        {
          slug: 'ship',
          title: 'Ship',
          job: null,
          autonomy: 'ask',
          gate: null,
          body: 'Ship the fix through the `ship-task` workflow: gate, pull request, merge.',
        },
      ],
    },
  },
]

export const BUILT_IN_WORKFLOW_AUTHOR = 'seed'

const floors: Record<string, Record<string, FloorKind[]>> = {
  'fix-defect': {
    diagnose: ['recorded-artifact'],
    fix: ['recorded-artifact'],
    verify: ['command-exit'],
    'blast-radius': ['recorded-artifact'],
    triage: ['ruling'],
    ship: ['command-exit', 'recorded-artifact'],
  },
}
const sharedConflicts = new Set(['fix', 'triage'])
const catalogueSlug = (workflow: string, step: string) =>
  sharedConflicts.has(step) ? `${workflow}-${step}` : step

export type SeedCatalogueStep = {
  slug: string
  title: string
  body: string
  floor: FloorKind[]
  deferrable?: FloorKind[]
  expectedStatus?: string
  requirePullRequest?: boolean
  job: string | null
  stage: AutonomyStage
  autonomy: AutonomyValue
  needs: string[]
}
const stages: Record<string, Record<string, SeedCatalogueStep['stage']>> = {
  'fix-defect': {
    diagnose: 'plan',
    fix: 'implement',
    verify: 'implement',
    'blast-radius': 'review',
    triage: 'review',
    ship: 'ship',
  },
}
const catalogueBody = (workflow: string, step: string, body: string) =>
  workflow === 'fix-defect' && step === 'verify'
    ? 'Reproduce the original condition before and after the fix, then run `{{gate}}`.'
    : body.replaceAll('bun run check', '{{gate}}')
const catalogueNeeds = (workflow: string, step: string, runsGate: boolean) => [
  ...(runsGate ? ['gate'] : []),
  ...(workflow === 'fix-defect' && step === 'diagnose' ? ['tracker'] : []),
]

export function catalogueDefinition() {
  return {
    steps: workflowSeeds.flatMap((seed) =>
      seed.definition.steps.map((legacy) => ({
        slug: catalogueSlug(seed.slug, legacy.slug),
        title: legacy.title,
        body: catalogueBody(seed.slug, legacy.slug, legacy.body),
        stage: stages[seed.slug]![legacy.slug]!,
        floor: floors[seed.slug]![legacy.slug]!,
        job: legacy.job,
        autonomy: legacy.autonomy as SeedCatalogueStep['autonomy'],
        needs: catalogueNeeds(seed.slug, legacy.slug, legacy.gate !== null),
      })),
    ),
  }
}

export function mergeSeededSteps<T extends { slug: string }>(
  current: readonly T[],
  seeded: readonly T[],
): T[] {
  const seededBySlug = new Map(seeded.map((step) => [step.slug, step]))
  const currentSlugs = new Set(current.map((step) => step.slug))
  return [
    ...current.map((step) => seededBySlug.get(step.slug) ?? step),
    ...seeded.filter((step) => !currentSlugs.has(step.slug)),
  ]
}

export function seedMayPromote(input: {
  seedRevision: number
  storedSeedRevision: number
  operatorPromoted: boolean
}): boolean {
  return input.seedRevision > input.storedSeedRevision && !input.operatorPromoted
}

export function workflowDefinition(seed: (typeof workflowSeeds)[number]) {
  const { steps: _steps, ...definition } = seed.definition
  return {
    ...definition,
    modes: definition.modes.map((mode) => ({
      ...mode,
      steps: expandWorkflowSteps(
        mode.steps.map((step) => catalogueSlug(seed.slug, step)),
        [],
      ),
    })),
  }
}

export function builtInWorkflowCatalogue() {
  return {
    stepCatalogue: {
      slug: 'shared',
      definition: JSON.stringify(catalogueDefinition()),
      author: BUILT_IN_WORKFLOW_AUTHOR,
      reason: 'seed r6',
    },
    workflows: workflowSeeds.map((seed) => ({
      slug: seed.slug,
      definition: JSON.stringify(workflowDefinition(seed)),
      author: BUILT_IN_WORKFLOW_AUTHOR,
      reason: `seed r${seed.revision}`,
    })),
  }
}
