import { attributionFindings } from '../../../shared/attribution-markers.ts'

export type SourcedAttributionFinding = {
  source: string
  line: number
  text: string
}

export function sourcedAttributionFindings(
  source: string,
  text: string,
): SourcedAttributionFinding[] {
  return attributionFindings(text).map((finding) => ({ source, ...finding }))
}

export function formatAttributionFinding(finding: SourcedAttributionFinding): string {
  return `${finding.source}:${finding.line}: ${finding.text}`
}
