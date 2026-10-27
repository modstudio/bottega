// concern: workflows
/** Resolves the registered project facts requested by workflow steps. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  composeIndexSources,
  type InjectionSource,
  type ResolvedReviewStage,
  resolveDeclaredFacts,
  type WorkflowFactSource,
} from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import type { WorkflowAutonomyResolution } from './autonomy.ts'
import { decideShipToReach, shipToRungNames } from './ship-to-reach.ts'

export type WorkflowFactProject = Pick<Project, 'name' | 'stack' | 'settings'>

const projectInjectionNeeds = (needs: readonly WorkflowFactSource[]): InjectionSource[] =>
  needs.filter(
    (source): source is InjectionSource =>
      source !== 'reference' && source !== 'ship-to' && source !== 'workflow-text',
  )

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

function shipToFact(
  project: WorkflowFactProject,
  needs: readonly WorkflowFactSource[],
  needsCloseState: boolean,
  args: Record<string, string>,
  autonomy: WorkflowAutonomyResolution,
  projectFacts: Record<string, unknown>,
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
  const decision = decideShipToReach(autonomy.shipTo.value, shipToRungNames(rungs), args.depth)
  if (!decision.allowed) throw new Error(decision.refusal)
  const tracker = needsCloseState ? (projectFacts.tracker as CloseTrackerFact) : undefined
  return {
    shipTo: {
      level: autonomy.shipTo.value,
      scope: autonomy.shipTo.scope,
      mayMerge: decision.mayMerge ? 'yes' : 'no',
      reach: decision.reach,
      remaining: decision.remaining,
      reachText: decision.reach.join(', ') || 'none',
      remainingText: decision.remaining.join(', ') || 'none',
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
  extras: readonly InjectionSource[] = [],
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
      ...referenceFact(project, needs),
      ...shipToFact(project, needs, needsCloseState, args, autonomy, projectFacts),
    },
  }
}

export const workflowCompositionFactExtras = composeIndexSources
