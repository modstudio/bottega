// concern: workflows
/** Reads pinned ruling authority and decides whether an answer has the authority it requires. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { showPinnedStepCatalogue } from './step-catalogue.ts'

export function pinnedWorkflowRuleStep(
  row: { catalogue_version_record_id: string; step_slug: string },
  cursor: string,
  d: Database,
) {
  const step = showPinnedStepCatalogue(row.catalogue_version_record_id, d).definition.steps.find(
    (candidate) => candidate.slug === row.step_slug,
  )
  if (!step)
    throw new Error(`${cursor} pinned step catalogue does not contain step "${row.step_slug}"`)
  return step
}

export function decideWorkflowRuleAnswer(input: {
  fromOperator: boolean
  operatorRuling: boolean
}): string | null {
  if (!input.operatorRuling || input.fromOperator) return null
  return `this step's ruling floor requires the operator's answer; relay the operator's answer with \`rule_workflow\` \`from_operator\` or \`${PLATFORM_SLUG} workflow rule --from-operator\`, or close the step with another floor's evidence where it has one`
}
