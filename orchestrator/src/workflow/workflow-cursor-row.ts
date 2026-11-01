// concern: workflows
/** Shared persisted cursor shape used to close one already-selected cursor. */

import type { SelectableCursorRow } from './workflow-cursor-selection.ts'
import type { EnforcementMode } from './workflow-floor.ts'

export type WorkflowCloseCursor = SelectableCursorRow & {
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
  closed: string
  question: string | null
  total_steps: number
  created_at: string
  updated_at: string
  enforcement: EnforcementMode
}
