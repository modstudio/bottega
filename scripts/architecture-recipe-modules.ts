// concern: architecture-manifest
/** Tracked-recipe module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type RecipeModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): RecipeModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recipeModules: RecipeModule[] = [
  module('orchestrator/src/health/recipe-executable-doctor.ts', [
    'node:fs',
    '../recipe/recipe-loader.ts',
    '../recipe/recipe-executable-preflight.ts',
    '../recipe/recipe-schema.ts',
    '../worktree/worktree-lifecycle.ts',
    './doctor-reporter.ts',
  ]),
  module('orchestrator/src/recipe/recipe-executable-preflight.ts', [
    './recipe-schema.ts',
    './recipe-step.ts',
  ]),
  module('orchestrator/src/recipe/env-file.ts', []),
  module('orchestrator/src/recipe/tracked-allocation-keys.ts', [
    '../resources/resource-claims.ts',
    './recipe-schema.ts',
  ]),
  module('orchestrator/src/recipe/tracked-allocation-claims.ts', [
    '../resources/resource-claims.ts',
    '../resources/resource-step-recorder.ts',
    './recipe-schema.ts',
    './tracked-allocation-keys.ts',
  ]),
  module('orchestrator/src/recipe/database-allocation-matcher.ts', []),
  module('orchestrator/src/recipe/database-connection-observation.ts', [
    './database-allocation-matcher.ts',
    './database-connection.ts',
    './database-provision.ts',
    './database-provision-plan.ts',
    './recipe-loader.ts',
    './recipe-schema.ts',
  ]),
  module('orchestrator/src/recipe/database-inventory.ts', [
    './database-allocation-matcher.ts',
    './database-connection.ts',
    './database-provision.ts',
    './database-provision-plan.ts',
    './recipe-loader.ts',
    './recipe-schema.ts',
  ]),
]
