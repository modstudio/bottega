// concern: record-review-presentation
/** Builds the one hosted-camelCase review graph shared by record readers. */
import type {
  RunDetailReviewFinding,
  RunDetailReviewLens,
} from '../../../shared/review-presentation.ts'

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

export const recordPresentation = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'bigint'
          ? Number(value)
          : value,
    ]),
  )

const nullableString = (value: unknown): string | null => (value == null ? null : String(value))
const nullableNumber = (value: unknown): number | null => (value == null ? null : Number(value))
const array = (value: unknown): unknown[] => (Array.isArray(value) ? [...value] : [])

function reviewFindingPresentation(row: Record<string, unknown>): RunDetailReviewFinding {
  const finding = recordPresentation(row)
  return {
    id: String(finding.id),
    reviewId: String(finding.reviewId),
    reviewLensId: String(finding.reviewLensId),
    ordinal: Number(finding.ordinal),
    severity: String(finding.severity),
    location: String(finding.location),
    evidence: String(finding.evidence),
    proposedCorrection: String(finding.proposedCorrection),
    disposition: nullableString(finding.disposition),
    rejectionCategory: nullableString(finding.rejectionCategory),
    triagedSeverity: nullableString(finding.triagedSeverity),
    triagedAt: nullableString(finding.triagedAt),
  }
}

export function reviewLensPresentation(row: Record<string, unknown>): RunDetailReviewLens {
  const lens = recordPresentation(row)
  return {
    id: String(lens.id),
    reviewId: String(lens.reviewId),
    runId: String(lens.runId),
    reviewNumber: nullableNumber(lens.reviewNumber),
    reviewProjectId: nullableString(lens.reviewProjectId),
    recordedAt: String(lens.recordedAt),
    completedAt: nullableString(lens.completedAt),
    tier: nullableNumber(lens.tier),
    patchId: nullableString(lens.patchId),
    commitMessage: nullableString(lens.commitMessage),
    lens: String(lens.lens),
    agent: String(lens.agent),
    model: nullableString(lens.model),
    treeInspected: nullableString(lens.treeInspected),
    reviewedTree: nullableString(lens.reviewedTree),
    standardsRead: array(lens.standardsRead),
    filesCovered: array(lens.filesCovered),
    commandsRun: array(lens.commandsRun),
    couldNotVerify: array(lens.couldNotVerify),
    mcpTools: array(lens.mcpTools),
    docsRead: array(lens.docsRead),
    substitutes: array(lens.substitutes),
    reproduced: nullableString(lens.reproduced),
    coverage: nullableString(lens.coverage),
    limits: nullableString(lens.limits),
    overlap: nullableString(lens.overlap),
    findings: array(row.findings).map((finding) =>
      reviewFindingPresentation(finding as Record<string, unknown>),
    ),
  }
}
