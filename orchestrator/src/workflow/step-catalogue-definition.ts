// concern: workflows
/** The stored step catalogue definition shared by lifecycle and rendering modules. */

import type { WorkflowFactSource } from '../project/project-injection.ts'
import type { AutonomyStage, AutonomyValue } from './autonomy.ts'
import type { CommandEvidence, FloorKind } from './workflow-floor.ts'

export type FloorEntry = FloorKind | `{{${string}}}`

export type CatalogueStep = {
  slug: string
  title: string
  body: string
  floor: FloorEntry[]
  deferrable?: FloorKind[]
  expectedStatus?: string
  requirePullRequest?: boolean
  operatorRuling?: boolean
  commandEvidence?: CommandEvidence
  job: string | null
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
