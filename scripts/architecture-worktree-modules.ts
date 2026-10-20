// concern: architecture-manifest
/** Worktree module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type WorktreeModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): WorktreeModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const worktreeModules: WorktreeModule[] = [
  module('orchestrator/src/reclaim/reclaim-worktree-dirty.ts', []),
  module('orchestrator/src/reclaim/reclaim-residue-policy.ts', ['../../../shared/brand.ts']),
  module('orchestrator/src/worktree/worktree-porcelain.ts', []),
  module('orchestrator/src/worktree/worktree-caller.ts', [
    '../project/projects.ts',
    '../git/git-environment.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-create.ts', [
    '../branch/create-time-settlement.ts',
    '../database/db.ts',
    '../project/projects.ts',
    '../recipe/recipe.ts',
    '../recipe/tracked-recipe.ts',
    './worktree-template.ts',
    './worktree-attribution.ts',
    '../git/git-environment.ts',
    '../project/project-lock.ts',
    './worktree-remove.ts',
    './worktree-caller.ts',
    './worktree-seed.ts',
    './worktree-tool.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-preflight.ts', [
    '../project/projects.ts',
    './worktree-template.ts',
    '../git/git-environment.ts',
  ]),
  module('orchestrator/src/worktree/worktree-readonly.ts', [
    '../project/projects.ts',
    './worktree-provision.ts',
    './worktree-template.ts',
    '../git/git-environment.ts',
    './worktree-remove.ts',
    './worktree-create.ts',
    './provisioning-measurement.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-provision.ts', ['node:fs', 'node:path']),
  module('orchestrator/src/worktree/provisioning-measurement.ts', [
    'node:fs',
    'node:path',
    '../database/db.ts',
    '../host-load-sample.ts',
    '../storage-walk.ts',
    './worktree-provision.ts',
  ]),
  module('orchestrator/src/worktree/worktree-remove.ts', [
    '../../../shared/brand.ts',
    '../database/db.ts',
    '../project/projects.ts',
    '../recipe/recipe.ts',
    '../recipe/tracked-recipe.ts',
    './worktree-attribution.ts',
    '../git/git-environment.ts',
    '../resources/ref-guard.ts',
    '../resources/resource-claims.ts',
    './snapshotless-tracked-recipe.ts',
    './removal-working-directory.ts',
    './worktree-tool.ts',
    './worktree-types.ts',
  ]),
  module('orchestrator/src/worktree/worktree-tool.ts', [
    './worktree-template.ts',
    '../git/git-environment.ts',
  ]),
  module('orchestrator/src/worktree/worktree-types.ts', []),
]
