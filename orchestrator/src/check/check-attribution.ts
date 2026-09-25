import { attributionFindings } from '../../../shared/attribution-markers.ts'
import { readFileSync } from 'node:fs'

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

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) {
    console.error('commit-msg: message path is required')
    process.exit(1)
  }
  const findings = attributionFindings(readFileSync(path, 'utf8'))
  for (const finding of findings) {
    console.error(`commit-msg:${finding.line}: AI attribution is not allowed: ${finding.text}`)
  }
  if (findings.length) process.exit(1)
}
