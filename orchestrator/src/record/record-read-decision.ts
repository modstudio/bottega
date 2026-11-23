// concern: record-read-decision
/** Decides shared-state read authority from plain install facts. */

import { decideRecordWrite, type RecordWriteDecision } from './record-write-decision.ts'

export type RecordReadDecision = RecordWriteDecision

export function decideRecordRead(
  input: Parameters<typeof decideRecordWrite>[0],
): RecordReadDecision {
  return decideRecordWrite(input)
}
