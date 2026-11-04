// concern: record-api
/** Maps hosted-service refusals to their HTTP status without hiding unexpected failures. */

import { RecordBoardError } from './record-board-contract.ts'
import { ConfigServiceError } from './record-config.ts'
import { RecordDocError } from './record-docs.ts'
import { RecordProjectError } from './record-projects.ts'
import { RecordVerdictError } from './record-verdicts.ts'

export function recordApiServiceError(error: unknown) {
  if (
    error instanceof RecordDocError ||
    error instanceof RecordVerdictError ||
    error instanceof ConfigServiceError ||
    error instanceof RecordProjectError ||
    error instanceof RecordBoardError
  ) {
    return error
  }
  return null
}
