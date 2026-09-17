// concern: tracked worktree refresh
/** Owns refresh policy and adapts git/register facts to the tracked recipe runner. */

import { basename, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  gitToplevel,
  inspectCheckout,
  mainCheckoutOf,
  resolvedPathsEqual,
} from '../../shared/git.ts'
import { git } from './git-environment.ts'
import { projects, resolvedWorktreeTool } from './projects.ts'
import { loadTrackedRecipe } from './recipe-loader.ts'
import { allocationEnvironmentVariable } from './recipe-schema.ts'
import { runStep, type StepContext } from './recipe-step.ts'
import { executeTrackedRefreshSteps } from './tracked-recipe.ts'

export type TreeRefreshDecision =
  | { action: 'fast-forward' }
  | { action: 'current' }
  | { action: 'refuse'; reason: 'dirty' | 'diverged' }

export function decideTreeRefresh(input: {
  clean: boolean
  ownCommits: number
  behindCommits: number
}): TreeRefreshDecision {
  if (!input.clean) return { action: 'refuse', reason: 'dirty' }
  if (input.behindCommits === 0) return { action: 'current' }
  if (input.ownCommits === 0) return { action: 'fast-forward' }
  return { action: 'refuse', reason: 'diverged' }
}

function countCommits(range: string, cwd: string): number {
  const value = git(['rev-list', '--count', range], cwd)
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`git returned invalid commit count ${JSON.stringify(value)} for ${range}`)
  }
  return count
}

function stepContext(
  treeRoot: string,
  main: string,
  branch: string,
  base: string,
  recipe: NonNullable<Extract<ReturnType<typeof loadTrackedRecipe>, { ok: true }>['recipe']>,
): StepContext {
  const vars: Record<string, string> = {
    branch,
    name: basename(treeRoot),
    base,
    key: '',
    seed: '',
    path: treeRoot,
    main,
    index: process.env.ORCH_INDEX ?? '',
    label: process.env.ORCH_RUN_LABEL ?? '',
    tree_exists: 'true',
  }
  for (const name of recipe.allocate?.ports ?? []) {
    const value = process.env[allocationEnvironmentVariable('ports', name)]
    if (value !== undefined) vars[`ports.${name}`] = value
  }
  for (const name of Object.keys(recipe.allocate?.databases ?? {})) {
    const value = process.env[allocationEnvironmentVariable('db', name)]
    if (value !== undefined) vars[`db.${name}`] = value
  }
  for (const name of Object.keys(recipe.allocate?.strings ?? {})) {
    const value = process.env[allocationEnvironmentVariable('alloc', name)]
    if (value !== undefined) vars[`alloc.${name}`] = value
  }
  return { treeRoot, vars }
}

function refreshTree(path: string): string[] {
  const requested = resolve(path)
  const treeRoot = gitToplevel(requested)
  if (!treeRoot) throw new Error(`path ${requested} is not a git worktree of a registered project`)
  const main = mainCheckoutOf(treeRoot)
  const project = main
    ? projects().find((candidate) => resolvedPathsEqual(candidate.path, main))
    : null
  if (!main || !project) {
    throw new Error(`path ${treeRoot} is not a git worktree of a registered project`)
  }
  if (resolvedPathsEqual(treeRoot, project.path)) {
    throw new Error(
      `path ${treeRoot} is the main checkout for project ${project.name}, not a worktree`,
    )
  }

  const trunk = project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${project.name} has no landing branch (register trunk)`)
  const tool = resolvedWorktreeTool(project)
  if (!tool?.recipePath) {
    throw new Error(
      `project ${project.name} has no tracked recipe; declare a tracked recipe in ${PLATFORM_SLUG}.jsonc`,
    )
  }

  const checkout = inspectCheckout(treeRoot)
  if (checkout.cleanliness === 'indeterminate') {
    throw new Error(`could not determine whether worktree ${treeRoot} has tracked changes`)
  }
  const dirtyDecision = decideTreeRefresh({
    clean: checkout.cleanliness === 'clean',
    ownCommits: 0,
    behindCommits: 0,
  })
  if (dirtyDecision.action === 'refuse') {
    throw new Error(
      `worktree ${treeRoot} has uncommitted tracked changes: ${checkout.dirtyTracked.join(', ')}`,
    )
  }

  const branch = git(['symbolic-ref', '--short', 'HEAD'], treeRoot)
  git(['fetch', 'origin', trunk], treeRoot)
  const remote = `origin/${trunk}`
  const mergeBase = git(['merge-base', 'HEAD', remote], treeRoot)
  const ownCommits = countCommits(`${mergeBase}..HEAD`, treeRoot)
  const behindCommits = countCommits(`${mergeBase}..${remote}`, treeRoot)
  const decision = decideTreeRefresh({ clean: true, ownCommits, behindCommits })
  const messages: string[] = []
  if (decision.action === 'refuse') {
    throw new Error(
      `worktree ${treeRoot} is ${behindCommits} commit(s) behind ${remote} and has ${ownCommits} own commit(s); rebase onto ${remote} before refreshing`,
    )
  }
  if (decision.action === 'fast-forward') {
    git(['merge', '--ff-only', remote], treeRoot)
    messages.push(`fast-forwarded ${branch} by ${behindCommits} commit(s) to ${remote}`)
  } else {
    messages.push(`${branch} is current with ${remote}`)
  }

  const loaded = loadTrackedRecipe(treeRoot, tool.recipePath)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  if (!loaded.recipe) {
    throw new Error(
      `tracked recipe ${tool.recipePath} declares no worktree lifecycle; declare one in ${PLATFORM_SLUG}.jsonc`,
    )
  }
  if (!loaded.recipe.refresh?.length) {
    messages.push(`tracked recipe ${tool.recipePath} has no refresh steps; ran no steps`)
    return messages
  }
  const failure = executeTrackedRefreshSteps(
    loaded.recipe,
    stepContext(
      treeRoot,
      project.path,
      branch,
      git(['rev-parse', 'HEAD'], treeRoot),
      loaded.recipe,
    ),
    runStep,
  )
  if (failure) {
    throw new Error(
      `worktree refresh failed at "${failure.name}" (${failure.phase}): ${failure.detail || `exit ${failure.exitCode ?? 'unknown'}`}`,
    )
  }
  messages.push(`ran ${loaded.recipe.refresh.length} refresh step(s)`)
  return messages
}

export function treeRefreshCommand(
  path: string,
  presentation: { log(message: string): void },
): void {
  for (const message of refreshTree(path)) presentation.log(message)
}
