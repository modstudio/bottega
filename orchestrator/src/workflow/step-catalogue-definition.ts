// concern: workflows
/** The stored step catalogue definition shared by lifecycle and rendering modules. */

import type { WorkflowFactSource } from '../project/project-injection.ts'
import type { AutonomyStage, AutonomyValue } from './autonomy.ts'
import type { CommandEvidence, FloorKind } from './workflow-floor.ts'
import type { DispatchWaiverFact } from './workflow-run-obligation.ts'

export type FloorEntry = FloorKind | `{{${string}}}`

export type CatalogueStep = {
  slug: string
  title: string
  body: string
  floor: FloorEntry[]
  outcomes?: string[]
  rulingOutcomes?: string[]
  outcomeFloors?: Record<string, FloorKind[]>
  reenter?: { to: string; outcome: string }
  deferrable?: FloorKind[]
  expectedExitCodes?: Record<string, number>
  expectedStatus?: string | string[]
  requirePullRequest?: boolean
  operatorRuling?: boolean
  commandEvidence?: CommandEvidence
  jobs: string[]
  dispatch?: 'required'
  dispatchWaivedBy?: DispatchWaiverFact[]
  judges?: string[]
  actions: string[]
  /** Optional only when reading a stored catalogue created before stages existed. */
  stage?: AutonomyStage
  autonomy: AutonomyValue
  needs: WorkflowFactSource[]
}

export type CatalogueSequence = {
  slug: string
  title: string
  steps: string[]
}

export type StepCatalogueDefinition = {
  steps: CatalogueStep[]
  sequences?: CatalogueSequence[]
}
