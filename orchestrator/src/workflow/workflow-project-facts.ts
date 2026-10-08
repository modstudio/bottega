// concern: workflows
/** Resolves the registered project facts requested by workflow steps. */

import {
  composeIndexSources,
  type InjectionSource,
  resolveDeclaredFacts,
  type ResolvedReviewStage,
  type WorkflowFactSource,
} from '../project/project-injection.ts'
import type { Project } from '../project/projects.ts'
import type { AutonomyResolution } from './autonomy.ts'
import { decideShipToReach } from './ship-to-reach.ts'

export type WorkflowFactProject = Pick<Project, 'name' | 'stack' | 'settings'>

const projectInjectionNeeds = (needs: readonly WorkflowFactSource[]): InjectionSource[] =>
  needs.filter(
    (source): source is InjectionSource => source !== 'ship-to' && source !== 'workflow-text',
  )

function closeShipToFact(
  projectName: string,
  remaining: number,
  tracker:
    | {
        states: Partial<Record<'review' | 'done', string>>
        inReview: ResolvedReviewStage
      }
    | undefined,
) {
  if (!tracker) return {}
  const closeAction = !remaining ? 'done' : tracker.inReview.state !== 'none' ? 'review' : 'ask'
  if (closeAction === 'done' && !tracker.states.done)
    throw new Error(
      `project ${projectName} tracker is missing workflow state "done"; set it with: orch project set ${projectName} --settings '{"tracker":{"states":{"<state-name>":"done"}}}'`,
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
  autonomy: AutonomyResolution,
  projectFacts: Record<string, unknown>,
) {
  if (!needs.includes('ship-to')) return {}
  if (autonomy.shipTo.complete === false)
    throw new Error(
      `hosted autonomy settings could not be read: ${autonomy.shipTo.unavailableReason}; retry when the hosted record is reachable, or set the level for this machine with orch config set --machine autonomy.ship-to <level>`,
    )
  const decision = decideShipToReach(
    autonomy.shipTo.value,
    project.settings.release?.rungs.map(({ name }) => name) ?? [],
    args.depth,
  )
  if (!decision.allowed) throw new Error(decision.refusal)
  const tracker = needsCloseState
    ? (projectFacts.tracker as {
        states: Partial<Record<'review' | 'done', string>>
        inReview: ResolvedReviewStage
      })
    : undefined
  return {
    shipTo: {
      level: autonomy.shipTo.value,
      scope: autonomy.shipTo.scope,
      mayMerge: decision.mayMerge ? 'yes' : 'no',
      reach: decision.reach,
      remaining: decision.remaining,
      reachText: decision.reach.join(', ') || 'none',
      remainingText: decision.remaining.join(', ') || 'none',
      ...closeShipToFact(project.name, decision.remaining.length, tracker),
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
  autonomy: AutonomyResolution,
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
      ...shipToFact(project, needs, needsCloseState, args, autonomy, projectFacts),
    },
  }
}

export const workflowCompositionFactExtras = composeIndexSources
