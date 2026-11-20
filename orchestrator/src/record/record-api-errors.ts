// concern: record-api
/** Maps hosted-service refusals to their HTTP status without hiding unexpected failures. */

import type { Context } from 'hono'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { DocRevisionConflictError, revisionConflictBody } from '../doc/doc-revision-conflict.ts'
import { OutboxRowError } from './outbox-failure.ts'
import { RecordBoardError } from './record-board-contract.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { RecordDocError } from './record-docs.ts'
import { RecordProjectPurgeError } from './record-project-purge-contract.ts'
import {
  projectSpaceConflictResponse,
  RecordProjectSpaceConflictError,
} from './record-project-space-contract.ts'
import { RecordProjectError } from './record-projects.ts'
import { RecordQuestionError } from './record-question-contract.ts'
import { SpaceDeleteError } from './record-trial-space-contract.ts'
import { RecordVerdictError } from './record-verdicts.ts'

export function renderRecordApiRefusal(context: Context, error: unknown): Response | null {
  if (error instanceof OutboxRowError && error.errorClass === 'row-validation')
    return context.json(
      error.remedy ? { error: error.message, remedy: error.remedy } : { error: error.message },
      422,
    )
  if (error instanceof DocRevisionConflictError)
    return context.json(revisionConflictBody(error), 409)
  if (error instanceof RecordProjectSpaceConflictError)
    return context.json(projectSpaceConflictResponse(error), error.status)
  if (error instanceof RecordProjectError && error.code === 'revision-conflict')
    return context.json(
      {
        error: renderRefusal(
          refusal(error.message, { kind: 'command', argv: [PLATFORM_SLUG, 'record', 'pull'] }),
        ),
      },
      error.status,
    )
  if (error instanceof RecordQuestionError)
    return context.json(
      error.code ? { error: error.message, code: error.code } : { error: error.message },
      error.status,
    )
  if (
    error instanceof RecordDocError ||
    error instanceof RecordVerdictError ||
    error instanceof ConfigServiceError ||
    error instanceof RecordProjectError ||
    error instanceof RecordBoardError ||
    error instanceof SpaceDeleteError ||
    error instanceof RecordProjectPurgeError
  ) {
    return context.json({ error: error.message }, error.status)
  }
  return null
}
