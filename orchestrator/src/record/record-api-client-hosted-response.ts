// concern: record API hosted-response policy
/** Adapts shared hosted JSON diagnostics to record-client error classification. */

import {
  hostedJsonFailureMessage,
  hostedStatusMessage,
  type JsonBodyResult,
} from '../../../shared/http-json.ts'

export const hostedErrorBody = (
  result: JsonBodyResult,
  url: string,
  status: number,
): unknown =>
  result.ok && result.value !== null
    ? result.value
    : {
        error: result.ok
          ? hostedStatusMessage(url, status)
          : hostedJsonFailureMessage(result),
      }
