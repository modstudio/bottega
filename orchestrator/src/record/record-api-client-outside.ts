// concern: record-api-client-outside
/** Composes hosted outside-intake and outside-author block requests. */

import { recordOutsideBlockClient } from './record-api-client-outside-block.ts'
import { recordOutsideIntakeClient } from './record-api-client-outside-intake.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'

export function recordOutsideClient(request: RecordClientRequest) {
  return { ...recordOutsideIntakeClient(request), ...recordOutsideBlockClient(request) }
}
