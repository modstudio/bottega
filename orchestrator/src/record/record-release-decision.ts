// concern: record-release-decision
/** Compares the record schema version with the migrations shipped in an image. */

export type RecordReleaseDecision =
  | { status: 'refuse'; applied: number; shipped: number }
  | { status: 'pass'; applied: number; shipped: number }
  | { status: 'warn'; applied: number; shipped: number }

export function decideRecordRelease(applied: number, shipped: number): RecordReleaseDecision {
  if (applied < shipped) return { status: 'refuse', applied, shipped }
  if (applied > shipped) return { status: 'warn', applied, shipped }
  return { status: 'pass', applied, shipped }
}
