// concern: workflows
/** Defines the evidence offers accepted when closing a workflow step. */

export type WorkflowEvidenceInput = {
  ruling?: number
  review?: string
  gate?: string | number
  run?: string
  artifacts?: string[]
  className?: string
  task?: string
  defer?: string
  satisfies?: string
}
