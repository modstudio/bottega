// concern: record-review-lens-values
/** Maps nullable review-lens payload fields without knowing hosted writes. */
import type { RecordPayload } from './record-sync-contract.ts'

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

export function nullableReviewLensValues(row: RecordPayload) {
  return {
    model: nullableString(row.model),
    treeInspected: nullableString(row.treeInspected),
    reviewedTree: nullableString(row.reviewedTree),
    selectionReason: nullableString(row.selectionReason),
    taskTextInput: nullableString(row.taskTextInput),
    rulingsInput: nullableString(row.rulingsInput),
  }
}
