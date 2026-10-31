// concern: workflows
/** Resolves the registered project facts requested by workflow steps. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import {
  composeIndexSources,
  type InjectionSource,
  type ResolvedReviewStage,
  resolveDeclaredFacts,
  type WorkflowFactSource,
} from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import { projectByName } from '../project/projects.ts'
import { changedPaths } from '../release/release-required.ts'
import type { WorkflowAutonomyResolution } from './autonomy.ts'
import { decideShipToReach, shipToReachNeedsMergedChange, shipToRungs } from './ship-to-reach.ts'
import { checkoutLanding } from './workflow-checkout-landing.ts'

export type WorkflowFactProject = Pick<Project, 'name' | 'stack' | 'settings'>

export type MergedChangeSources = {
  landing(project: WorkflowFactProject, branch: string): string | null
  changedPaths(project: string, mergeCommit: string): readonly string[]
}

export function mergedChangeSources(database: Database = db()): MergedChangeSources {
  return {
    landing: (project, branch) => checkoutLanding(project.name, branch, database).commit,
    changedPaths(project, mergeCommit) {
      const registered = projectByName(project, database)
      if (!registered) throw new Error(`unknown project "${project}"`)
      try {
        return changedPaths(registered, mergeCommit)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `cannot read the files changed by merge ${mergeCommit} in ${project}: ${message}; cleared by: fetching the landing branch in the registered checkout, then fetching this step again`,
        )
      }
    },
  }
}

/** The merged change is established when its step is fetched after merge, never at compose. */
export const workflowCompositionFactNeeds = (
  needs: readonly WorkflowFactSource[],
): WorkflowFactSource[] => needs.filter((source) => source !== 'merged-change')

const projectInjectionNeeds = (needs: readonly WorkflowFactSource[]): InjectionSource[] =>
  needs.filter(
    (source): source is InjectionSource =>
      source !== 'before-pull-request' &&
      source !== 'reference' &&
      source !== 'ship-to' &&
      source !== 'merged-change' &&
      source !== 'workflow-text',
  )

function beforePullRequestFact(project: WorkflowFactProject, needs: readonly WorkflowFactSource[]) {
  if (!needs.includes('before-pull-request')) return {}
  return { beforePullRequest: project.settings.release?.beforePullRequest ?? [] }
}

function referenceFact(project: WorkflowFactProject, needs: readonly WorkflowFactSource[]) {
  if (!needs.includes('reference') || !project.settings.reference) return {}
  return { reference: project.settings.reference }
}

type CloseTrackerFact = {
  states: Partial<Record<'review' | 'done', string>>
  inReview: ResolvedReviewStage
  completesOnMerge: boolean
}

function closeShipToAction(
  remaining: number,
  mayMerge: boolean,
  tracker: CloseTrackerFact,
): 'ask' | 'done' | 'review' {
  if (!mayMerge) return 'ask'
  if (!remaining || tracker.completesOnMerge) return 'done'
  return tracker.inReview.state !== 'none' ? 'review' : 'ask'
}

function closeShipToFact(
  projectName: string,
  remaining: number,
  mayMerge: boolean,
  tracker: CloseTrackerFact | undefined,
) {
  if (!tracker) return {}
  const closeAction = closeShipToAction(remaining, mayMerge, tracker)
  if (closeAction === 'done' && !tracker.states.done)
    throw new Error(
      `project ${projectName} tracker is missing workflow state "done"; set it with: ${PLATFORM_SLUG} project set ${projectName} --settings '{"tracker":{"states":{"<state-name>":"done"}}}'`,
    )
  return {
    closeAction,
    closeFloor: closeAction === 'ask' ? 'ruling' : 'tracker-transition',
    closeState:
      closeAction === 'done'
        ? tracker.states.done
        : closeAction === 'review'
          ? tracker.inReview.state
          : 'none',
  }
}

function mergedChangeFor(
  project: WorkflowFactProject,
  branch: string | undefined,
  needed: boolean,
  sources: MergedChangeSources,
): { changedPaths: readonly string[] } | undefined {
  if (!needed) return undefined
  if (!branch)
    throw new Error(
      'cannot establish the merged change: this step needs the branch argument; cleared by: passing --arg branch=<branch> to the workflow',
    )
  const mergeCommit = sources.landing(project, branch)
  if (!mergeCommit)
    throw new Error(
      `cannot establish the merged commit of ${branch}: no landing is recorded and no merged pull request is known for it; cleared by: ${PLATFORM_SLUG} tree branch landed ${branch} --pr <number> for a run branch, or merging its pull request through ${PLATFORM_SLUG} pr merge`,
    )
  return { changedPaths: sources.changedPaths(project.name, mergeCommit) }
}

function shipToFact(
  project: WorkflowFactProject,
  needs: readonly WorkflowFactSource[],
  needsCloseState: boolean,
  args: Record<string, string>,
  autonomy: WorkflowAutonomyResolution,
  projectFacts: Record<string, unknown>,
  sources: MergedChangeSources,
) {
  if (!needs.includes('ship-to')) return {}
  if (!autonomy.shipTo) {
    const cursor = 'cursor' in autonomy ? autonomy.cursor : undefined
    if (!cursor) throw new Error('resolved autonomy has no ship-to level')
    throw new Error(
      `workflow cursor ${cursor.id}'s stored autonomy has no ship-to level; clear it with: ${PLATFORM_SLUG} workflow abandon --cursor ${cursor.id} --reason "<why>"; then start a new run with: ${cursor.composeCommand}`,
    )
  }
  if (autonomy.shipTo.complete === false)
    throw new Error(
      `hosted autonomy settings could not be read: ${autonomy.shipTo.unavailableReason}; retry when the hosted record is reachable, or set the level for this machine with ${PLATFORM_SLUG} machine config set --machine autonomy.ship-to <level>`,
    )
  const rungs = project.settings.release?.rungs ?? []
  const depthRung = rungs.find(({ name }) => name === args.depth)
  if (depthRung?.onDemand)
    throw new Error(
      `ship-to depth "${depthRung.name}" names a rung released on demand with ${PLATFORM_SLUG} release run ${project.name} --rung ${depthRung.name} and cannot be a ship-to depth`,
    )
  const reachableRungs = shipToRungs(rungs)
  const initialDecision = decideShipToReach(autonomy.shipTo.value, reachableRungs, args.depth)
  if (!initialDecision.allowed) throw new Error(initialDecision.refusal)
  const changeGatedReach = shipToReachNeedsMergedChange(reachableRungs, initialDecision.reach)
  const needsMergedChange = needs.includes('merged-change') && changeGatedReach
  const merge = mergedChangeFor(project, args.branch, needsMergedChange, sources)
  const decision = decideShipToReach(autonomy.shipTo.value, reachableRungs, args.depth, merge)
  if (!decision.allowed) throw new Error(decision.refusal)
  const tracker = needsCloseState ? (projectFacts.tracker as CloseTrackerFact) : undefined
  return {
    shipTo: {
      level: autonomy.shipTo.value,
      scope: autonomy.shipTo.scope,
      mayMerge: decision.mayMerge ? 'yes' : 'no',
      reach: decision.reach,
      remaining: decision.remaining,
      skipped: decision.skipped,
      reachText: decision.reach.join(', ') || 'none',
      remainingText: decision.remaining.join(', ') || 'none',
      skippedText:
        decision.skipped.map(({ name, reason }) => `${name} (${reason})`).join('; ') ||
        (changeGatedReach && !merge ? 'decided from the merged change at promotion' : 'none'),
      ...closeShipToFact(project.name, decision.remaining.length, decision.mayMerge, tracker),
    },
  }
}

/** Close-state facts apply to a step that needs both the ship-to level and the tracker. */
export const stepNeedsCloseState = (needs: readonly WorkflowFactSource[]): boolean =>
  needs.includes('ship-to') && needs.includes('tracker')

export function resolveWorkflowProjectFacts(
  project: WorkflowFactProject,
  needs: readonly WorkflowFactSource[],
  needsCloseState: boolean,
  args: Record<string, string>,
  autonomy: WorkflowAutonomyResolution,
  extras: readonly InjectionSource[],
  sources: MergedChangeSources,
) {
  const { resolved, facts: projectFacts } = resolveDeclaredFacts(
    project,
    projectInjectionNeeds(needs),
    args,
    extras,
  )
  return {
    resolved,
    facts: {
      ...projectFacts,
      ...beforePullRequestFact(project, needs),
      ...referenceFact(project, needs),
      ...shipToFact(project, needs, needsCloseState, args, autonomy, projectFacts, sources),
    },
  }
}

export const workflowCompositionFactExtras = composeIndexSources
