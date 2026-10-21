// concern: workflows
/** The stored workflow definition shared by lifecycle and rendering modules. */

import type { AutonomyPreset } from './autonomy.ts'

export type WorkflowStepCondition = { step: string; outcome: string[] }
export type WorkflowModeStep =
  | string
  | { sequence: string; omit?: string[] }
  | { step: string; when: WorkflowStepCondition }

type WorkflowArgument = {
  name: string
  required: boolean
  description: string
  rebind?: boolean
}

export type WorkflowMode = {
  slug: string
  title: string
  default?: boolean
  entry?: string
  requires?: string[]
  steps: WorkflowModeStep[]
}

export type WorkflowDefinition = {
  title: string
  description: string
  defaultPreset?: AutonomyPreset
  arguments: WorkflowArgument[]
  modes: WorkflowMode[]
}
