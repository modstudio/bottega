import { type CanonFinding, refusingCanonFindings, warningCanonFindings } from './canon-lint.ts'

export function canonMirrorLintDecision(findings: CanonFinding[]): {
  refusal: string | null
  warnings: string[]
} {
  const errors = refusingCanonFindings(findings)
  return {
    refusal: errors.length
      ? `canon lint found ${errors.length} findings: ${errors.map((finding) => `${finding.file}:${finding.line} ${finding.message}`).join('; ')}`
      : null,
    warnings: warningCanonFindings(findings).map(
      (finding) =>
        `canon lint warning: ${finding.file}:${finding.line} ${finding.rule} ${finding.message}`,
    ),
  }
}
