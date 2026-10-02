// concern: tracked worktree reseeding
/** Resolves one existing tree's recorded owner and runs its project-defined reseed hook. */

import { resolvedPathsEqual } from '../../../shared/git.ts'
import { recordedChainRootsForWorktree } from '../dispatch/dispatch-preflight.ts'
import { git } from '../git/git-environment.ts'
import { loadTrackedRecipe } from './recipe-loader.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import { runStep } from './recipe-step.ts'
import { readSnapshot } from './tracked-recipe.ts'
import { refreshStepContext, refreshTarget, registeredRefreshTarget } from './tree-refresh.ts'

export function reseedStep(recipe: TrackedRecipe, recipePath: string) {
  const step = recipe.seeds?.reseed
  if (step) return step
  throw new Error(
    `tracked recipe ${recipePath} has no reseed hook; add worktree.seeds.reseed to the recipe`,
  )
}

export function reseedSeed(
  requested: string | undefined,
  recorded: string | null,
  choices: string[],
): string {
  const selected = requested ?? recorded
  if (selected !== null && selected !== undefined) return selected
  const guidance = choices.map((choice) => JSON.stringify(choice)).join(', ')
  throw new Error(
    `this tree has no recorded launch seed; run orch tree reseed <seed> (recipe choices: ${guidance})`,
  )
}

function reseedTree(path: string, requestedSeed: string | undefined): string[] {
  const registered = registeredRefreshTarget(path)
  if (resolvedPathsEqual(registered.treeRoot, registered.main)) {
    throw new Error(`orch tree reseed refuses the main checkout ${registered.treeRoot}`)
  }
  const { project, treeRoot, recipePath } = refreshTarget(registered)
  const roots = recordedChainRootsForWorktree(treeRoot)
  if (roots.length !== 1) {
    throw new Error(
      roots.length === 0
        ? `worktree ${treeRoot} has no recorded owner; refusing to reseed`
        : `worktree ${treeRoot} is recorded by multiple root runs: ${roots.join(', ')}; refusing to reseed`,
    )
  }
  const owner = readSnapshot(roots[0]!)
  const loaded = loadTrackedRecipe(treeRoot, recipePath)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  if (!loaded.recipe) {
    throw new Error(`tracked recipe ${recipePath} declares no worktree lifecycle`)
  }
  const reseed = reseedStep(loaded.recipe, recipePath)
  const seed = reseedSeed(requestedSeed, owner.seed, loaded.recipe.seeds?.choices ?? [])
  const branch = git(['symbolic-ref', '--short', 'HEAD'], treeRoot)
  const context = refreshStepContext({
    treeRoot,
    main: project.path,
    branch,
    head: git(['rev-parse', 'HEAD'], treeRoot),
    owner,
  })
  context.vars.seed = seed
  const result = runStep(reseed, context)
  if (result.status !== 'ok') {
    throw new Error(
      `worktree reseed failed at "${result.name}" (${result.phase}): ${result.detail || `exit ${result.exitCode ?? 'unknown'}`}`,
    )
  }
  return [`ran reseed step "${reseed.name}" with seed ${JSON.stringify(seed)}`]
}

export function treeReseedCommand(
  path: string,
  seed: string | undefined,
  presentation: { log(message: string): void },
): void {
  for (const message of reseedTree(path, seed)) presentation.log(message)
}
