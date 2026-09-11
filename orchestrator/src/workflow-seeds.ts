// concern: workflows
/** Knows the built-in workflow definitions and advances them by seed revision.
 * Must not know workflow commands, adapters, execution, or project state. */
import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from './db.ts'
import { REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_REPRODUCED } from './review-vocabulary.ts'

const seedDefinition = (definition: unknown) => JSON.stringify(definition)

const seeds = [
  {
    slug: 'ship', revision: 2,
    definition: {
      title: 'Ship a task', description: 'Rebase, independently review, triage, fix, merge by pull request, and close a task.',
      arguments: [
        { name: 'key', required: true, description: 'The task key.' },
        { name: 'branch', required: true, description: 'The branch to ship.' },
        { name: 'worktree', required: true, description: "The branch's worktree path." },
      ],
      modes: [{ slug: 'default', title: 'Ship', default: true,
        steps: ['rebase','lens','score','triage','complete','fix','pr','merge','close'] }],
      steps: [
        { slug: 'rebase', title: 'Rebase and verify', job: null, autonomy: 'auto', gate: 'bun run check', body: 'In `{{worktree}}`, run `git fetch origin` and `git rebase origin/main`, run `bun install` in the repository root, `orchestrator/` and `hub/`, then run `bun run check` in the foreground. If the gate fails only because a ceiling baseline tightened, commit the rewritten `scripts/quality/*.json` and re-run.' },
        { slug: 'lens', title: 'Run independent review lenses', job: 'review-lens', autonomy: 'auto', gate: null, body: "Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree's ./bin/orch, which writes to an empty per-worktree orch.db. Dispatch each named lens against the branch. Always run correctness. Also run migration-safety when the change touches `orchestrator/src/db.ts` or `orchestrator/migrations/`. Also run craft when the change adds a new module.\n\n`/absolute/path/to/main-checkout/bin/orch do review-lens --review {{branch}} --key {{key}} --lens correctness \"Review {{key}}: the change on {{branch}} against its task.\"`\n\nRepeat with the same prompt and --lens migration-safety or --lens craft when those apply." },
        { slug: 'score', title: 'Score the lenses', job: null, autonomy: 'auto', gate: null, body: `Read every lens result and run \`orch score <run-id> <delivery> <quality> --reproduced <${REVIEW_REPRODUCED.join('|')}> --coverage <${REVIEW_COVERAGE.join('|')}> --limits <${REVIEW_LIMITS.join('|')}> --overlap <${REVIEW_OVERLAP.join('|')}> --note "..."\` honestly for each. Grading records the lens on the review; there is no separate record step.` },
        { slug: 'triage', title: 'Triage every finding', job: null, autonomy: 'ask', gate: null, body: 'The architect must mark every finding accepted, modified, rejected, or skipped with `orch review triage <review-id> <finding> <disposition>`.' },
        { slug: 'complete', title: 'Complete the review', job: null, autonomy: 'auto', gate: null, body: 'After every finding is triaged, run `orch review complete <review-id>`.' },
        { slug: 'fix', title: 'Fix accepted findings', job: 'implement', autonomy: 'ask', gate: null, body: 'Only if findings were accepted or modified, run `orch continue <original-run-id> "Fix the accepted review findings."`. Then loop back to `lens`, because the tree changed.' },
        { slug: 'pr', title: 'Open the pull request', job: null, autonomy: 'ask', gate: null, body: 'Push the branch with `git -C {{worktree}} push -u origin {{branch}}`, then open a pull request with `gh pr create --base main --head {{branch}} --title "{{key}} <summary>" --body-file <file>`; the body states what changed, why, and the gate result.' },
        { slug: 'merge', title: 'Merge and pull', job: null, autonomy: 'ask', gate: null, body: 'Merge on GitHub with `gh pr merge <number> --squash --delete-branch`. Then, in the main checkout, run `git pull --ff-only`, and run `orch migrate` and `hub migrate` when the change carries a migration.' },
        { slug: 'close', title: 'Close the task', job: null, autonomy: 'auto', gate: null, body: 'Remove the worktree and delete the local branch, then run `hub task comment {{key}} "Shipped in #<number>."` and `hub task close {{key}}`.' },
      ],
    },
  },
  {
    slug: 'filed-issue', revision: 2,
    definition: {
      title: 'Resolve a filed issue', description: "A projection of issue.ts's coordinator for inspection.",
      arguments: [{ name: 'key', required: true, description: 'The filed task key.' }],
      modes: [{ slug: 'default', title: 'Resolve', default: true,
        steps: ['diagnose','fix','verify','blast-radius','triage','ship'] }],
      steps: [
        { slug: 'diagnose', title: 'Diagnose', job: 'diagnose', autonomy: 'auto', gate: null, body: 'Dispatch `orch do diagnose --key {{key}}` and establish the cause before editing.' },
        { slug: 'fix', title: 'Fix', job: 'issue-worker', autonomy: 'auto', gate: null, body: 'Dispatch `orch do issue-worker --key {{key}}` with the diagnosis.' },
        { slug: 'verify', title: 'Verify', job: null, autonomy: 'auto', gate: 'bun run check', body: 'Reproduce the original condition before and after the fix, then run the registered project gate.' },
        { slug: 'blast-radius', title: 'Review blast radius', job: 'review-lens', autonomy: 'auto', gate: null, body: "Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree's ./bin/orch, which writes to an empty per-worktree orch.db. Run `/absolute/path/to/main-checkout/bin/orch do review-lens --review <fix-branch> --key {{key}} --lens issue-blast-radius \"Review the fix for {{key}} for its blast radius.\"`, where `<fix-branch>` is the branch `orch result` prints for the issue-worker run." },
        { slug: 'triage', title: 'Triage findings', job: null, autonomy: 'ask', gate: null, body: 'The architect triages every recorded finding before the issue can land.' },
        { slug: 'ship', title: 'Ship', job: null, autonomy: 'ask', gate: null, body: 'Ship the fix through the `ship` workflow: gate, pull request, merge.' },
      ],
    },
  },
]

function storedSeedRevision(d: Database, workflowId: number): number {
  const events = d.query("SELECT reason FROM workflow_event WHERE workflow_id=? AND author='seed'")
    .all(workflowId) as { reason: string }[]
  return events.reduce((highest, { reason }) => {
    if (reason === 'DEV-257 seed') return Math.max(highest, 1)
    const revision = reason.match(/^seed r(\d+)$/)?.[1]
    return revision ? Math.max(highest, Number(revision)) : highest
  }, 0)
}

export function seedWorkflows(d: Database): void {
  const now = nowIso()
  writeTransaction(() => {
    for (const seed of seeds) {
      const reason = `seed r${seed.revision}`
      let workflow = d.query('SELECT id FROM workflow WHERE slug=?').get(seed.slug) as { id: number } | null
      if (!workflow) {
        workflow = d.query('INSERT INTO workflow (slug, created_at) VALUES (?, ?) RETURNING id')
          .get(seed.slug, now) as { id: number }
        d.query(`INSERT INTO workflow_version
          (workflow_id,n,status,definition,author,reason,created_at,promoted_at)
          VALUES (?,1,'production',?,'seed',?,?,?)`)
          .run(workflow.id, seedDefinition(seed.definition), reason, now, now)
        d.query(`INSERT INTO workflow_event
          (workflow_id,version_n,event,author,reason,session_id,at)
          VALUES (?,1,'set','seed',?,NULL,?)`).run(workflow.id, reason, now)
        continue
      }
      if (seed.revision <= storedSeedRevision(d, workflow.id)) continue
      // A workflow may have no production version (a draft never promoted); then there is nothing to retire.
      const prior = d.query("SELECT n FROM workflow_version WHERE workflow_id=? AND status='production'")
        .get(workflow.id) as { n: number } | null
      const { n: maxN } = d.query('SELECT COALESCE(MAX(n),0) AS n FROM workflow_version WHERE workflow_id=?')
        .get(workflow.id) as { n: number }
      const n = maxN + 1
      if (prior) {
        d.query("UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_id=? AND status='production'")
          .run(now, workflow.id)
        d.query(`INSERT INTO workflow_event
          (workflow_id,version_n,event,author,reason,session_id,at)
          VALUES (?,?,'retire','seed',?,NULL,?)`).run(workflow.id, prior.n, reason, now)
      }
      d.query(`INSERT INTO workflow_version
        (workflow_id,n,status,definition,author,reason,created_at,promoted_at)
        VALUES (?,?,'production',?,'seed',?,?,?)`)
        .run(workflow.id, n, seedDefinition(seed.definition), reason, now, now)
      d.query(`INSERT INTO workflow_event
        (workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,?,'set','seed',?,NULL,?)`).run(workflow.id, n, reason, now)
      d.query(`INSERT INTO workflow_event
        (workflow_id,version_n,event,author,reason,session_id,at)
        VALUES (?,?,'promote','seed',?,NULL,?)`).run(workflow.id, n, reason, now)
    }
  }, d)
}
