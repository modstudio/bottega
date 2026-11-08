// concern: record-api
/** Maps hosted-service refusals to their HTTP status without hiding unexpected failures. */

import type { Context } from 'hono'
import { RecordBoardError } from './record-board-contract.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { RecordDocError } from './record-docs.ts'
import {
  projectSpaceConflictResponse,
  RecordProjectSpaceConflictError,
} from './record-project-space-contract.ts'
import { RecordProjectError } from './record-projects.ts'
import { TrialSpaceDeleteError } from './record-trial-space-contract.ts'
import { RecordVerdictError } from './record-verdicts.ts'

export function renderRecordApiRefusal(context: Context, error: unknown): Response | null {
  if (error instanceof RecordProjectSpaceConflictError)
    return context.json(projectSpaceConflictResponse(error), error.status)
  if (
    error instanceof RecordDocError ||
    error instanceof RecordVerdictError ||
    error instanceof ConfigServiceError ||
    error instanceof RecordProjectError ||
    error instanceof RecordBoardError ||
    error instanceof TrialSpaceDeleteError
  ) {
    return context.json({ error: error.message }, error.status)
  }
  return null
}
