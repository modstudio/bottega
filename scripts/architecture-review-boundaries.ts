export type ReviewBoundarySpec = {
  name: string
  file: string
  allowed: string[]
  reason: string
  typeOnlyAllowed?: string[]
}

export const reviewBoundarySpecs: ReviewBoundarySpec[] = [
  {
    name: 'review-command-dispatcher-boundary',
    file: 'orchestrator/src/review/review-command-dispatcher.ts',
    allowed: [
      './review-commands.ts',
      './review-finding-amend-command.ts',
      './review-finding-restore.ts',
      './review-read.ts',
      './review-triage-restore.ts',
    ],
    reason:
      'Keep review verb routing beside the review commands and independent of CLI registration.',
  },
  {
    name: 'review-finding-amend-command-boundary',
    file: 'orchestrator/src/review/review-finding-amend-command.ts',
    allowed: ['./review-triage.ts', './review-vocabulary.ts'],
    reason: 'Keep completed-review amendment command parsing inside the review concern.',
  },
  {
    name: 'review-boundary',
    file: 'orchestrator/src/review/review.ts',
    allowed: [
      '../../../shared/record/schema.ts',
      '../database/db.ts',
      './review-outbox.ts',
      '../contract/contract.ts',
      '../jobs/jobs.ts',
      './review-coverage.ts',
      './review-coverage-match.ts',
      './review-group.ts',
      './review-pins.ts',
      './review-tier.ts',
    ],
    typeOnlyAllowed: ['bun:sqlite', './review-types.ts'],
    reason: 'Keep review verdicts independent of landing policy and run-chain ownership.',
  },
  {
    name: 'review-commands-boundary',
    file: 'orchestrator/src/review/review-commands.ts',
    allowed: [
      'bun:sqlite',
      'node:fs',
      'zod',
      '../../../shared/git.ts',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../jobs/jobs.ts',
      '../project/projects.ts',
      './review.ts',
      './review-calibration.ts',
      './review-coverage.ts',
      './review-evidence-sql.ts',
      './review-pins.ts',
      './review-target.ts',
      './review-tier.ts',
      './review-triage.ts',
      './review-vocabulary.ts',
      './review-yield.ts',
    ],
    reason:
      'Keep review commands independent of runs, transports, routing by value, the CLI, and worktrees by value.',
  },
  {
    name: 'review-finding-restore-boundary',
    file: 'orchestrator/src/review/review-finding-restore.ts',
    allowed: [
      'bun:sqlite',
      'node:fs',
      'node:path',
      'zod',
      '../database/db.ts',
      './review-finding-restore-policy.ts',
    ],
    reason: 'Keep review-finding restoration in its SQLite adapter and pure policy.',
  },
  {
    name: 'review-finding-restore-policy-boundary',
    file: 'orchestrator/src/review/review-finding-restore-policy.ts',
    allowed: ['zod'],
    reason: 'Keep review-finding restore decisions independent of SQLite.',
  },
  {
    name: 'review-triage-restore-boundary',
    file: 'orchestrator/src/review/review-triage-restore.ts',
    allowed: [
      'bun:sqlite',
      'zod',
      '../database/db.ts',
      './review-triage.ts',
      './review-triage-restore-policy.ts',
    ],
    reason: 'Keep review-triage restoration in its SQLite adapter and pure policy.',
  },
  {
    name: 'review-triage-restore-policy-boundary',
    file: 'orchestrator/src/review/review-triage-restore-policy.ts',
    allowed: [],
    typeOnlyAllowed: ['./review-triage.ts'],
    reason: 'Keep review-triage restore decisions independent of SQLite.',
  },
  {
    name: 'review-outbox-boundary',
    file: 'orchestrator/src/review/review-outbox.ts',
    allowed: [
      '../../../shared/record/schema.ts',
      '../database/db.ts',
      '../record/outbox-sanitize.ts',
      'bun:sqlite',
    ],
    reason: 'Enforce the review-outbox concern boundary.',
  },
  {
    name: 'review-read-boundary',
    file: 'orchestrator/src/review/review-read.ts',
    allowed: [
      'bun:sqlite',
      '../../../shared/record/schema.ts',
      '../../../shared/secret-shaped.ts',
      '../caller-classification.ts',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
      './review-group.ts',
      './review-outbox.ts',
    ],
    reason: 'Keep architect review reads inside the review evidence concern.',
  },
  {
    name: 'review-target-boundary',
    file: 'orchestrator/src/review/review-target.ts',
    allowed: [
      'node:path',
      '../git/git-environment.ts',
      '../project/projects.ts',
      '../worktree/worktree-caller.ts',
    ],
    reason: 'Keep review-target resolution independent of execution and mutation concerns.',
  },
  {
    name: 'review-vocabulary-boundary',
    file: 'orchestrator/src/review/review-vocabulary.ts',
    allowed: [],
    reason: 'Enforce the review-vocabulary concern boundary.',
  },
]
