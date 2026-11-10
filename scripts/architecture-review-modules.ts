// concern: architecture-manifest
/** Review module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, join } from 'node:path'

type ReviewModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): ReviewModule => ({
  file,
  allowed: allowed.map((target) => (target.startsWith('.') ? join(dirname(file), target) : target)),
})

export const reviewModules: ReviewModule[] = [
  module('orchestrator/src/lens/lens-commands.ts', [
    'node:fs',
    '../../../shared/record-api-url.ts',
    '../../../shared/record-space-owner-destination.ts',
    '../cli/args.ts',
    '../database/db.ts',
    '../project/projects.ts',
    '../record/record-space.ts',
    './lenses.ts',
  ]),
  module('orchestrator/src/review/review-calibration.ts', [
    '../database/db.ts',
    '../route/evidence-model.ts',
    './review-vocabulary.ts',
    '../state/statistics.ts',
    './review-evidence-sql.ts',
    './review-triage.ts',
  ]),
  module('orchestrator/src/review/review-coverage.ts', [
    '../../../shared/git-path-list.ts',
    '../database/db.ts',
    './change-identity.ts',
    './review-evidence-sql.ts',
    './review-pins.ts',
    './review-target.ts',
    './review-types.ts',
    '../../../shared/bounded-process.ts',
  ]),
  module('orchestrator/src/review/review-coverage-match.ts', []),
  module('orchestrator/src/review/review-declared-globs.ts', []),
  module('orchestrator/src/review/review-finding-location.ts', []),
  module('orchestrator/src/review/review-evidence-sql.ts', [
    '../evidence/evidence-query.ts',
    '../project/project-injection.ts',
  ]),
  module('orchestrator/src/review/review-identifier.ts', [
    '../../../shared/record-id.ts',
    'bun:sqlite',
  ]),
  module('orchestrator/src/review/review-number.ts', [
    '../database/entity-number.ts',
    'bun:sqlite',
  ]),
  module('orchestrator/src/review/review-read.ts', [
    'shared/brand.ts',
    'bun:sqlite',
    '../../../shared/record/schema.ts',
    '../../../shared/secret-shaped.ts',
    '../caller-classification.ts',
    '../database/db.ts',
    '../git/commit-resolution.ts',
    '../worktree/evidence-checkout.ts',
    '../git/git-environment.ts',
    '../project/projects.ts',
    './review-command-cwd.ts',
    './review-group.ts',
    './review-lineage-store.ts',
    './review-outbox.ts',
    '../../../shared/bounded-process.ts',
  ]),
  module('orchestrator/src/review/review-pins.ts', [
    '../../../shared/git-path-list.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    './change-identity.ts',
    './review-types.ts',
    '../../../shared/bounded-process.ts',
  ]),
  module('orchestrator/src/review/review-triage.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    './review-vocabulary.ts',
    '../contract/contract.ts',
    './review.ts',
    './review-outbox.ts',
  ]),
  module('orchestrator/src/review/review-types.ts', [
    './review-vocabulary.ts',
    './change-identity.ts',
    './review-role.ts',
  ]),
]
