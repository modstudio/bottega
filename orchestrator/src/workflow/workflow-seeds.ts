// concern: workflows
/** Knows the built-in workflow definitions and advances them by seed revision.
 * Must not know workflow commands, adapters, execution, or project state. */
import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from '../database/db.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import type { AutonomyStage, AutonomyValue } from './autonomy.ts'
import { validateStepCatalogue } from './step-catalogue.ts'

const seedDefinition = (definition: unknown) => JSON.stringify(definition)

const seeds = [
  {
    slug: 'ship',
    revision: 3,
    definition: {
      title: 'Ship a task',
      description:
        'Rebase, independently review, triage, fix, merge by pull request, and close a task.',
      arguments: [
        { name: 'key', required: true, description: 'The task key.' },
        { name: 'branch', required: true, description: 'The branch to ship.' },
        { name: 'worktree', required: true, description: "The branch's worktree path." },
      ],
      modes: [
        {
          slug: 'default',
          title: 'Ship',
          default: true,
          steps: ['rebase', 'lens', 'score', 'triage', 'complete', 'fix', 'pr', 'merge', 'close'],
        },
      ],
      steps: [
        {
          slug: 'rebase',
          title: 'Rebase and verify',
          job: null,
          autonomy: 'auto',
          gate: 'bun run check',
          body: 'In `{{worktree}}`, run `git fetch origin` and `git rebase origin/main`, run `bun install` in the repository root, then run `bun run check` in the foreground. If the gate fails only because a ceiling baseline tightened, commit the rewritten `scripts/quality/*.json` and re-run.',
        },
        {
          slug: 'lens',
          title: 'Run independent review lenses',
          job: 'review-lens',
          autonomy: 'auto',
          gate: null,
          body: 'Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree\'s ./bin/orch, whose access to the shared per-user store is read-only. Dispatch each named lens against the branch. Always run correctness. Also run migration-safety when the change touches `orchestrator/src/database/db.ts` or `orchestrator/migrations/`. Also run craft when the change adds a new module.\n\n`/absolute/path/to/main-checkout/bin/orch do review-lens --review {{branch}} --key {{key}} --lens correctness "Review {{key}}: the change on {{branch}} against its task."`\n\nRepeat with the same prompt and --lens migration-safety or --lens craft when those apply.',
        },
        {
          slug: 'score',
          title: 'Score the lenses',
          job: null,
          autonomy: 'auto',
          gate: null,
          body: `Read every lens result and run \`orch score <run-id> <delivery> <quality> --reproduced <${REVIEW_REPRODUCED.join('|')}> --coverage <${REVIEW_COVERAGE.join('|')}> --limits <${REVIEW_LIMITS.join('|')}> --overlap <${REVIEW_OVERLAP.join('|')}> --note "..."\` honestly for each. Grading records the lens on the review; there is no separate record step.`,
        },
        {
          slug: 'triage',
          title: 'Triage every finding',
          job: null,
          autonomy: 'ask',
          gate: null,
          body: 'The architect must mark every finding accepted, modified, rejected, or skipped with `orch review triage <review-id> <finding> <disposition>`.',
        },
        {
          slug: 'complete',
          title: 'Complete the review',
          job: null,
          autonomy: 'auto',
          gate: null,
          body: 'After every finding is triaged, run `orch review complete <review-id>`.',
        },
        {
          slug: 'fix',
          title: 'Fix accepted findings',
          job: 'implement',
          autonomy: 'ask',
          gate: null,
          body: 'Only if findings were accepted or modified, run `orch continue <original-run-id> "Fix the accepted review findings."`. Then loop back to `lens`, because the tree changed.',
        },
        {
          slug: 'pr',
          title: 'Open the pull request',
          job: null,
          autonomy: 'ask',
          gate: null,
          body: 'Push the branch with `git -C {{worktree}} push -u origin {{branch}}`, then open a pull request with `gh pr create --base main --head {{branch}} --title "{{key}} <summary>" --body-file <file>`; the body states what changed, why, and the gate result.',
        },
        {
          slug: 'merge',
          title: 'Merge and pull',
          job: null,
          autonomy: 'ask',
          gate: null,
          body: 'Merge on GitHub with `gh pr merge <number> --squash --delete-branch`. Then, in the main checkout, run `git pull --ff-only`, and run `orch migrate` and `hub migrate` when the change carries a migration.',
        },
        {
          slug: 'close',
          title: 'Close the task',
          job: null,
          autonomy: 'auto',
          gate: null,
          body: 'Remove the worktree and delete the local branch, then run `hub task comment {{key}} "Shipped in #<number>."` and `hub task close {{key}}`.',
        },
      ],
    },
  },
  {
    slug: 'fix-defect',
    revision: 4,
    definition: {
      title: 'Fix one reported defect',
      description: "A projection of the 'orch fix-defect' command's coordinator for inspection.",
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
          body: 'Dispatch `orch do diagnose --key {{key}} "Diagnose {{key}}: read it with {{tracker.actions.get}}, establish its cause with file:line evidence, and change nothing."` and establish the cause before editing.',
        },
        {
          slug: 'fix',
          title: 'Fix',
          job: 'issue-worker',
          autonomy: 'auto',
          gate: null,
          body: 'Write the fix specification to a file: the recorded diagnosis, the before-fix reproduction, the fix to make, and what must remain true. Dispatch `orch do issue-worker --key {{key}} --file <specification file>`.',
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
          body: 'Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree\'s ./bin/orch, whose access to the shared per-user store is read-only. Run `/absolute/path/to/main-checkout/bin/orch do review-lens --review <fix-branch> --key {{key}} --lens issue-blast-radius "Review the fix for {{key}} for its blast radius."`, where `<fix-branch>` is the branch `orch result` prints for the issue-worker run.',
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
          body: 'Ship the fix through the `ship` workflow: gate, pull request, merge.',
        },
      ],
    },
  },
]

const floors: Record<string, Record<string, string[]>> = {
  ship: {
    rebase: ['command-exit'],
    lens: ['recorded-artifact'],
    score: ['recorded-artifact'],
    triage: ['ruling'],
    complete: ['recorded-artifact'],
    fix: ['command-exit', 'recorded-artifact'],
    pr: ['command-exit', 'recorded-artifact'],
    merge: ['command-exit', 'recorded-artifact'],
    close: ['tracker-transition'],
  },
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

type LegacySeed = (typeof seeds)[number]
type SeedCatalogueStep = {
  slug: string
  title: string
  body: string
  floor: string[]
  job: string | null
  stage: AutonomyStage
  autonomy: AutonomyValue
  needs: string[]
}
const stages: Record<string, Record<string, SeedCatalogueStep['stage']>> = {
  ship: {
    rebase: 'ship',
    lens: 'review',
    score: 'review',
    triage: 'review',
    complete: 'review',
    fix: 'review',
    pr: 'ship',
    merge: 'ship',
    close: 'ship',
  },
  'fix-defect': {
    diagnose: 'plan',
    fix: 'implement',
    verify: 'implement',
    'blast-radius': 'review',
    triage: 'review',
    ship: 'ship',
  },
}
const usesTrunk = (workflow: string, step: string) =>
  workflow === 'ship' && (step === 'rebase' || step === 'pr')
function catalogueBody(workflow: string, step: string, legacyBody: string): string {
  if (workflow === 'fix-defect' && step === 'verify')
    return 'Reproduce the original condition before and after the fix, then run `{{gate}}`.'
  if (!usesTrunk(workflow, step)) return legacyBody.replaceAll('bun run check', '{{gate}}')
  return legacyBody
    .replaceAll('bun run check', '{{gate}}')
    .replace('origin/main', 'origin/{{trunk}}')
    .replace('--base main', '--base {{trunk}}')
}
function catalogueDefinition() {
  const steps: SeedCatalogueStep[] = []
  for (const seed of seeds) {
    for (const legacy of seed.definition.steps) {
      const runsGate = legacy.gate !== null
      const runsOnTrunk = usesTrunk(seed.slug, legacy.slug)
      steps.push({
        slug: catalogueSlug(seed.slug, legacy.slug),
        title: legacy.title,
        body: catalogueBody(seed.slug, legacy.slug, legacy.body),
        stage: stages[seed.slug]![legacy.slug]!,
        floor: floors[seed.slug]![legacy.slug]!,
        job: legacy.job,
        autonomy: legacy.autonomy as SeedCatalogueStep['autonomy'],
        needs: [...(runsGate ? ['gate'] : []), ...(runsOnTrunk ? ['trunk'] : [])],
      })
    }
  }
  return { steps }
}

export function mergeSeededSteps<T extends { slug: string }>(
  current: readonly T[],
  seeded: readonly T[],
): T[] {
  const seededBySlug = new Map(seeded.map((step) => [step.slug, step])),
    currentSlugs = new Set(current.map((step) => step.slug))
  return [
    ...current.map((step) => seededBySlug.get(step.slug) ?? step),
    ...seeded.filter((step) => !currentSlugs.has(step.slug)),
  ]
}

export function seedMayPromote({
  seedRevision,
  storedSeedRevision,
  operatorPromoted,
}: {
  seedRevision: number
  storedSeedRevision: number
  operatorPromoted: boolean
}): boolean {
  return seedRevision > storedSeedRevision && !operatorPromoted
}

function workflowDefinition(seed: LegacySeed) {
  const { steps: _steps, ...definition } = seed.definition
  return {
    ...definition,
    modes: definition.modes.map((mode) => ({
      ...mode,
      steps: mode.steps.map((step) => catalogueSlug(seed.slug, step)),
    })),
  }
}

function seedCatalogue(d: Database, now: string): void {
  const seeded = catalogueDefinition(),
    seededDefinition = JSON.stringify(seeded),
    revision = 3,
    reason = `seed r${revision}`
  requireValidSeedCatalogue(seeded)
  let catalogue = d.query("SELECT id FROM step_catalogue WHERE slug='shared'").get() as {
    id: number
  } | null
  if (!catalogue) {
    catalogue = d
      .query("INSERT INTO step_catalogue (slug,created_at) VALUES ('shared',?) RETURNING id")
      .get(now) as { id: number }
    d.query(
      `INSERT INTO step_catalogue_version (catalogue_id,n,status,definition,author,reason,created_at,promoted_at) VALUES (?,1,'production',?,'seed',?,?,?)`,
    ).run(catalogue.id, seededDefinition, reason, now, now)
    d.query(
      `INSERT INTO step_catalogue_event (catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,1,'set','seed',?,NULL,?)`,
    ).run(catalogue.id, reason, now)
    return
  }
  if (
    !seedMayPromote({
      seedRevision: revision,
      storedSeedRevision: storedCatalogueSeedRevision(d, catalogue.id),
      operatorPromoted: operatorPromotedCatalogue(d, catalogue.id),
    })
  )
    return
  const prior = d
    .query(
      "SELECT n,definition FROM step_catalogue_version WHERE catalogue_id=? AND status='production'",
    )
    .get(catalogue.id) as { n: number; definition: string } | null
  const assembled = prior
    ? {
        steps: mergeSeededSteps(
          (JSON.parse(prior.definition) as { steps: SeedCatalogueStep[] }).steps,
          seeded.steps,
        ),
      }
    : seeded
  requireValidSeedCatalogue(assembled)
  const definition = JSON.stringify(assembled)
  if (prior?.definition === definition) return
  const { n: maxN } = d
    .query('SELECT COALESCE(MAX(n),0) AS n FROM step_catalogue_version WHERE catalogue_id=?')
    .get(catalogue.id) as { n: number }
  const n = maxN + 1
  if (prior) {
    d.query(
      "UPDATE step_catalogue_version SET status='retired',retired_at=? WHERE catalogue_id=? AND status='production'",
    ).run(now, catalogue.id)
    d.query(
      `INSERT INTO step_catalogue_event (catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,'retire','seed',?,NULL,?)`,
    ).run(catalogue.id, prior.n, reason, now)
  }
  d.query(
    `INSERT INTO step_catalogue_version (catalogue_id,n,status,definition,author,reason,created_at,promoted_at) VALUES (?,?,'production',?,'seed',?,?,?)`,
  ).run(catalogue.id, n, definition, reason, now, now)
  d.query(
    `INSERT INTO step_catalogue_event (catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,'set','seed',?,NULL,?)`,
  ).run(catalogue.id, n, reason, now)
  d.query(
    `INSERT INTO step_catalogue_event (catalogue_id,version_n,event,author,reason,session_id,at) VALUES (?,?,'promote','seed',?,NULL,?)`,
  ).run(catalogue.id, n, reason, now)
}

function requireValidSeedCatalogue(definition: unknown): void {
  const errors = validateStepCatalogue(definition)
  if (errors.length)
    throw new Error(
      `invalid seeded step catalogue:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    )
}

function storedCatalogueSeedRevision(d: Database, catalogueId: number): number {
  const events = d
    .query("SELECT reason FROM step_catalogue_event WHERE catalogue_id=? AND author='seed'")
    .all(catalogueId) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

function operatorPromotedCatalogue(d: Database, catalogueId: number): boolean {
  return (
    d
      .query(
        "SELECT 1 FROM step_catalogue_event WHERE catalogue_id=? AND event='promote' AND author!='seed' LIMIT 1",
      )
      .get(catalogueId) != null
  )
}

function storedSeedRevision(d: Database, workflowId: number): number {
  const events = d
    .query("SELECT reason FROM workflow_event WHERE workflow_id=? AND author='seed'")
    .all(workflowId) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    if (reason === 'DEV-257 seed') return Math.max(highest, 1)
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

function operatorPromotedWorkflow(d: Database, workflowId: number): boolean {
  return (
    d
      .query(
        "SELECT 1 FROM workflow_event WHERE workflow_id=? AND event='promote' AND author!='seed' LIMIT 1",
      )
      .get(workflowId) != null
  )
}

export function seedWorkflows(d: Database): void {
  const now = nowIso()
  writeTransaction(() => {
    seedCatalogue(d, now)
    for (const seed of seeds) {
      const reason = `seed r${seed.revision}`
      let workflow = d.query('SELECT id FROM workflow WHERE slug=?').get(seed.slug) as {
        id: number
      } | null
      if (!workflow) {
        workflow = d
          .query('INSERT INTO workflow (slug, created_at) VALUES (?, ?) RETURNING id')
          .get(seed.slug, now) as { id: number }
        d.query(`INSERT INTO workflow_version
          (workflow_id,n,status,definition,author,reason,created_at,promoted_at)
          VALUES (?,1,'production',?,'seed',?,?,?)`).run(
          workflow.id,
          seedDefinition(workflowDefinition(seed)),
          reason,
          now,
          now,
        )
        d.query(`INSERT INTO workflow_event
          (workflow_id,version_n,event,author,reason,session_id,at)
          VALUES (?,1,'set','seed',?,NULL,?)`).run(workflow.id, reason, now)
        continue
      }
      if (
        !seedMayPromote({
          seedRevision: seed.revision,
          storedSeedRevision: storedSeedRevision(d, workflow.id),
          operatorPromoted: operatorPromotedWorkflow(d, workflow.id),
        })
      )
        continue
      // A workflow may have no production version (a draft never promoted); then there is nothing to retire.
      const prior = d
        .query("SELECT n FROM workflow_version WHERE workflow_id=? AND status='production'")
        .get(workflow.id) as { n: number } | null
      const { n: maxN } = d
        .query('SELECT COALESCE(MAX(n),0) AS n FROM workflow_version WHERE workflow_id=?')
        .get(workflow.id) as { n: number }
      const n = maxN + 1
      if (prior) {
        d.query(
          "UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_id=? AND status='production'",
        ).run(now, workflow.id)
        d.query(`INSERT INTO workflow_event
          (workflow_id,version_n,event,author,reason,session_id,at)
          VALUES (?,?,'retire','seed',?,NULL,?)`).run(workflow.id, prior.n, reason, now)
      }
      d.query(`INSERT INTO workflow_version
        (workflow_id,n,status,definition,author,reason,created_at,promoted_at)
        VALUES (?,?,'production',?,'seed',?,?,?)`).run(
        workflow.id,
        n,
        seedDefinition(workflowDefinition(seed)),
        reason,
        now,
        now,
      )
      d.query(`INSERT INTO workflow_event
        (workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,?,'set','seed',?,NULL,?)`).run(workflow.id, n, reason, now)
      d.query(`INSERT INTO workflow_event
        (workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,?,'promote','seed',?,NULL,?)`).run(workflow.id, n, reason, now)
    }
  }, d)
}
