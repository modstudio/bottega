// concern: tracked worktree refresh
/** Owns refresh policy and adapts git/register facts to the tracked recipe runner. */

import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitToplevel, inspectCheckout, resolvedPathsEqual } from '../../../shared/git.ts'
import { recordedChainRootsForWorktree } from '../dispatch/dispatch-preflight.ts'
import { git, gitOk, repoRootOf } from '../git/git-environment.ts'
import { projectAt, resolvedWorktreeTool } from '../project/projects.ts'
import { orchRunLabel } from '../resources/docker-resources.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { teardownVars } from './recipe-lifecycle.ts'
import { loadTrackedRecipe } from './recipe-loader.ts'
import { stepPlaceholders, type TrackedRecipe } from './recipe-schema.ts'
import { runStep, type StepContext } from './recipe-step.ts'
import { executeTrackedRefreshSteps, type RecipeSnapshot, readSnapshot } from './tracked-recipe.ts'

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

export type MainCheckoutBranchDecision =
  | { action: 'refresh' }
  | { action: 'refuse'; branch: string | null }

export function decideMainCheckoutBranch(
  branch: string | null,
  trunk: string,
): MainCheckoutBranchDecision {
  return branch === trunk ? { action: 'refresh' } : { action: 'refuse', branch }
}

function countCommits(range: string, cwd: string): number {
  const value = git(['rev-list', '--count', range], cwd)
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`git returned invalid commit count ${JSON.stringify(value)} for ${range}`)
  }
  return count
}

type RefreshOwner = {
  snapshot: RecipeSnapshot | null
  key: string | null
  seed: string | null
  rootRunId: number
}

const SNAPSHOT_STATIC_PLACEHOLDERS = new Set(['key', 'seed', 'index', 'label'])

export function snapshotlessRefreshPlaceholder(recipe: TrackedRecipe): {
  step: string
  placeholder: string
} | null {
  for (const step of recipe.refresh ?? []) {
    const placeholder = stepPlaceholders(step).find(
      ({ name, allocation }) => allocation || SNAPSHOT_STATIC_PLACEHOLDERS.has(name),
    )
    if (placeholder) return { step: step.name, placeholder: placeholder.name }
  }
  return null
}

export function requireRefreshSnapshot(
  recipe: TrackedRecipe,
  hasSnapshot: boolean,
  treeRoot: string,
): void {
  if (hasSnapshot) return
  const unavailable = snapshotlessRefreshPlaceholder(recipe)
  if (!unavailable) return
  throw new Error(
    `refresh step "${unavailable.step}" references lifecycle placeholder {${unavailable.placeholder}}, but worktree ${treeRoot} has no recorded recipe snapshot`,
  )
}

export function refreshStepContext(input: {
  treeRoot: string
  main: string
  branch: string
  head: string
  owner: RefreshOwner | null
}): StepContext {
  const { owner } = input
  if (!owner?.snapshot) {
    return {
      treeRoot: input.treeRoot,
      vars: teardownVars({
        path: input.treeRoot,
        branch: input.branch,
        base: input.head,
        key: null,
        seed: null,
        main: input.main,
        label: '',
        treeExists: true,
      }),
    }
  }
  return {
    treeRoot: input.treeRoot,
    vars: teardownVars({
      path: input.treeRoot,
      branch: input.branch,
      base: owner.snapshot.source.commit,
      key: owner.key,
      seed: owner.seed,
      main: input.main,
      label: orchRunLabel(owner.rootRunId),
      treeExists: true,
      allocations: owner.snapshot.allocations,
    }),
  }
}

/** Bind a path to its registered project and landing branch, or refuse. */
function registeredRefreshTarget(path: string) {
  const requested = resolve(path)
  const project = projectAt(requested)
  const treeRoot = gitToplevel(requested)
  if (!project || !treeRoot) {
    throw new Error(`path ${requested} is not a git worktree of a registered project`)
  }
  const main = repoRootOf(treeRoot)
  if (!main || !resolvedPathsEqual(main, project.path)) {
    throw new Error(`path ${treeRoot} is not a git worktree of a registered project`)
  }
  const trunk = project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${project.name} has no landing branch (register trunk)`)
  return { project, treeRoot, main, trunk }
}

/** Bind a non-main checkout to its tracked recipe, or refuse. */
function refreshTarget(target: ReturnType<typeof registeredRefreshTarget>) {
  const { project, treeRoot, trunk } = target
  const tool = resolvedWorktreeTool(project)
  const lifecycle = resolveWorktreeLifecycle(tool)
  if (!tool || lifecycle.form !== 'tracked-recipe') {
    throw new Error(
      `project ${project.name} has no tracked recipe; declare a tracked recipe in ${PLATFORM_SLUG}.jsonc`,
    )
  }
  return { project, treeRoot, trunk, recipePath: lifecycle.recipePath }
}

function refreshMainCheckout(target: ReturnType<typeof registeredRefreshTarget>): string[] {
  const { treeRoot, trunk } = target
  const branch = gitOk(['symbolic-ref', '--quiet', '--short', 'HEAD'], treeRoot)
  const branchDecision = decideMainCheckoutBranch(branch, trunk)
  if (branchDecision.action === 'refuse') {
    throw new Error(
      `main checkout ${treeRoot} is on branch ${branchDecision.branch ?? '(detached HEAD)'}, expected trunk ${trunk}; the main checkout must be on trunk to be refreshed`,
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

  git(['fetch', 'origin', trunk], treeRoot)
  const remote = `origin/${trunk}`
  const mergeBase = git(['merge-base', 'HEAD', remote], treeRoot)
  const ownCommits = countCommits(`${mergeBase}..HEAD`, treeRoot)
  const behindCommits = countCommits(`${mergeBase}..${remote}`, treeRoot)
  const decision = decideTreeRefresh({ clean: true, ownCommits, behindCommits })
  if (decision.action === 'refuse') {
    throw new Error(
      `worktree ${treeRoot} is ${behindCommits} commit(s) behind ${remote} and has ${ownCommits} own commit(s); rebase onto ${remote} before refreshing`,
    )
  }
  if (decision.action === 'fast-forward') {
    git(['merge', '--ff-only', remote], treeRoot)
    return [`fast-forwarded ${branch} by ${behindCommits} commit(s) to ${remote}`]
  }
  return [`${branch} is current with ${remote}`]
}

function refreshWorktree(target: ReturnType<typeof registeredRefreshTarget>): string[] {
  const { project, treeRoot, trunk, recipePath } = refreshTarget(target)
  const loaded = loadTrackedRecipe(treeRoot, recipePath)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  if (!loaded.recipe) {
    throw new Error(
      `tracked recipe ${recipePath} declares no worktree lifecycle; declare one in ${PLATFORM_SLUG}.jsonc`,
    )
  }
  const roots = recordedChainRootsForWorktree(treeRoot)
  if (roots.length > 1) {
    throw new Error(
      `worktree ${treeRoot} is recorded by multiple root runs: ${roots.join(', ')}; refusing to refresh`,
    )
  }
  const owner = roots[0] === undefined ? null : readSnapshot(roots[0])
  requireRefreshSnapshot(loaded.recipe, Boolean(owner?.snapshot), treeRoot)

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

  if (!loaded.recipe.refresh?.length) {
    messages.push(`tracked recipe ${recipePath} has no refresh steps; ran no steps`)
    return messages
  }
  const failure = executeTrackedRefreshSteps(
    loaded.recipe,
    refreshStepContext({
      treeRoot,
      main: project.path,
      branch,
      head: git(['rev-parse', 'HEAD'], treeRoot),
      owner,
    }),
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

function refreshTree(path: string): string[] {
  const target = registeredRefreshTarget(path)
  return resolvedPathsEqual(target.treeRoot, target.main)
    ? refreshMainCheckout(target)
    : refreshWorktree(target)
}

export function treeRefreshCommand(
  path: string,
  presentation: { log(message: string): void },
): void {
  for (const message of refreshTree(path)) presentation.log(message)
}
