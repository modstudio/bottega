// concern: workflow run obligation
/** Decides dispatch and judging obligations from already gathered run-chain facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowCursorNumberOption } from './workflow-cursor-format.ts'

export type WorkflowRunChainEvidence = {
  number: number
  job: string
  terminal: boolean
  needsVerdict: boolean
}

export const dispatchWaiverFacts = ['no-lens-owed', 'no-accepted-findings'] as const
export type DispatchWaiverFact = (typeof dispatchWaiverFacts)[number]

export type StepRunObligation = {
  slug: string
  jobs: string[]
  dispatch?: 'required'
  dispatchWaivedBy?: DispatchWaiverFact[]
  judges?: string[]
}

export type WorkflowRunObligationInput = {
  workflowKey?: string
  cursorNumber?: number
  selectedFloors: string[]
  metWaiverFacts: DispatchWaiverFact[]
  step?: StepRunObligation
  dispatchRuns?: WorkflowRunChainEvidence[]
  earlierStepRuns?: { number: number; stepSlug: string }[]
  judgedRuns?: WorkflowRunChainEvidence[]
}

function scoreRemedy(runs: readonly WorkflowRunChainEvidence[]): string {
  return runs.map((run) => `\`${PLATFORM_SLUG} score ${run.number} ...\``).join(', ')
}

export function dispatchObligationRefusal(input: WorkflowRunObligationInput): string | null {
  const step = input.step
  if (step?.dispatch !== 'required') return null
  if (input.selectedFloors.includes('descendants-closed')) return null
  if ((step.dispatchWaivedBy ?? []).some((fact) => input.metWaiverFacts.includes(fact))) return null
  const runs = input.dispatchRuns ?? []
  if (!runs.length) {
    const job = step.jobs[0] ?? '<job>'
    const earlier = input.earlierStepRuns ?? []
    if (earlier.length) {
      const cursor = workflowCursorNumberOption(input.cursorNumber ?? '<n>')
      const chainSummary = earlier
        .map(
          (run) =>
            `chain ${run.number} was bound at step ${run.stepSlug} before this step activated, so it is not credited here`,
        )
        .join('; ')
      return (
        `dispatch obligation is unmet: no ${step.jobs.join(' or ') || 'declared-job'} run is bound ` +
        `to this cursor at step ${step.slug}; ${chainSummary}. ` +
        `A finding applied before triage needs a confirmation turn at this step; ` +
        `run \`${PLATFORM_SLUG} run continue --findings${cursor} ${earlier[0]!.number} "<message>"\`; ` +
        `its successful exit meets the obligation`
      )
    }
    return (
      `dispatch obligation is unmet: no ${step.jobs.join(' or ') || 'declared-job'} run was dispatched ` +
      `from this cursor at step ${step.slug}; dispatch one with ` +
      `\`${PLATFORM_SLUG} run start ${job} --key ${input.workflowKey || '<KEY>'} ...\` from this cursor`
    )
  }
  const running = runs.filter((run) => !run.terminal)
  if (running.length)
    return (
      `dispatch obligation is unmet: run ${running.map((run) => run.number).join(', ')} ` +
      `${running.length === 1 ? 'is' : 'are'} not terminal; wait for each dispatched chain to finish, then score it`
    )
  const unscored = runs.filter((run) => run.job !== 'review-lens' && run.needsVerdict)
  if (!unscored.length) return null
  return (
    `dispatch obligation is unmet: run ${unscored.map((run) => run.number).join(', ')} ` +
    `${unscored.length === 1 ? 'still needs' : 'still need'} a verdict; score each chain with ${scoreRemedy(unscored)}`
  )
}

export function judgingObligationRefusal(input: WorkflowRunObligationInput): string | null {
  const judges = input.step?.judges
  if (!judges?.length) return null
  const unscored = (input.judgedRuns ?? []).filter((run) => run.needsVerdict)
  if (!unscored.length) return null
  return (
    `judging obligation is unmet: ${judges.join(' or ')} run ` +
    `${unscored.map((run) => run.number).join(', ')} ${unscored.length === 1 ? 'is' : 'are'} unscored; ` +
    `score each chain with ${scoreRemedy(unscored)}`
  )
}
