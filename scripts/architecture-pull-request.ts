export const pullRequestModuleSpecs = [
  {
    file: 'orchestrator/src/pull-request/triage-decision.ts',
    allowed: [
      '../review/review-group.ts',
      '../review/review-applicability.ts',
      '../project/project-injection.ts',
    ],
  },
  { file: 'orchestrator/src/pull-request/pre-push-decision.ts', allowed: [] },
  { file: 'orchestrator/src/pull-request/override-decision.ts', allowed: [] },
  {
    file: 'orchestrator/src/pull-request/admission-decision.ts',
    allowed: ['./triage-decision.ts'],
  },
  {
    file: 'orchestrator/src/pull-request/pr-admission.ts',
    allowed: [
      'bun:sqlite',
      '../../../shared/record/schema.ts',
      '../../../shared/secret-shaped.ts',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
      '../record/landing-outbox.ts',
      '../review/review-group.ts',
      '../review/review-applicability.ts',
      './admission-decision.ts',
      './override-decision.ts',
      './pre-push-decision.ts',
      './triage-decision.ts',
    ],
  },
  {
    file: 'orchestrator/src/review/review-group.ts',
    allowed: [
      'bun:sqlite',
      '../project/projects.ts',
      './review-pins.ts',
      './review-target.ts',
      './review-tier.ts',
    ],
  },
] as const
