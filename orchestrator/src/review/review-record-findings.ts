// concern: review-record-findings
/** Decides and writes the one findings shape passed to a project's review recorder. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

type ReviewRecordVerdict = 'accept' | 'modify' | 'reject'

type ReviewRecordFinding = {
  lens: string
  verdict: ReviewRecordVerdict
  category?: string
  severity?: string
  location?: string
  run: number
}

export type ReviewRecordFindingsFile = {
  lenses: string[]
  findings: ReviewRecordFinding[]
  skipped: number
}

export type ReviewRecordRow = {
  lens: string
  run: number
  disposition: 'accepted' | 'modified' | 'rejected' | 'skipped' | null
  category: string | null
  severity: string | null
  location: string | null
}

const verdicts = {
  accepted: 'accept',
  modified: 'modify',
  rejected: 'reject',
} as const

/** Pure export decision over review lens rows and their architect dispositions. */
export function reviewRecordFindings(rows: readonly ReviewRecordRow[]): ReviewRecordFindingsFile {
  const findings: ReviewRecordFinding[] = []
  let skipped = 0
  for (const row of rows) {
    if (row.disposition === null) continue
    if (row.disposition === 'skipped') {
      skipped++
      continue
    }
    findings.push({
      lens: row.lens,
      verdict: verdicts[row.disposition],
      ...(row.disposition === 'rejected' && row.category ? { category: row.category } : {}),
      ...(row.severity ? { severity: row.severity } : {}),
      ...(row.location ? { location: row.location } : {}),
      run: row.run,
    })
  }
  return {
    lenses: [...new Set(rows.map((row) => row.lens))],
    findings,
    skipped,
  }
}

/** The sole writer for the project-facing findings file. */
export function writeReviewRecordFindings(path: string, findings: ReviewRecordFindingsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(findings, null, 2)}\n`, { mode: 0o600 })
}
