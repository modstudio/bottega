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

export function workflowsAfterReplacement<Definition>(
  rows: readonly { slug: string; definition: string }[],
  incomingSlug: string,
  incomingDefinition: Definition,
): { slug: string; definition: string }[] {
  const definition = JSON.stringify(incomingDefinition)
  if (!rows.some((row) => row.slug === incomingSlug))
    return [...rows, { slug: incomingSlug, definition }]
  return rows.map((row) => (row.slug === incomingSlug ? { slug: incomingSlug, definition } : row))
}
