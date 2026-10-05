import { readFileSync } from 'node:fs'
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

export function checkAttributionMain(argv: string[]): number {
  const path = argv[0]
  if (!path) {
    console.error('commit-msg: message path is required')
    return 1
  }
  const findings = attributionFindings(readFileSync(path, 'utf8'))
  for (const finding of findings) {
    console.error(`commit-msg:${finding.line}: AI attribution is not allowed: ${finding.text}`)
  }
  return findings.length ? 1 : 0
}

if (import.meta.main) process.exitCode = checkAttributionMain(process.argv.slice(2))
