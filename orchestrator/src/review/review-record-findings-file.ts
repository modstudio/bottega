// concern: review-record-findings-file
/** Writes the project-facing review findings interchange file. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ReviewRecordFindingsFile } from './review-record-findings.ts'

export function writeReviewRecordFindings(path: string, findings: ReviewRecordFindingsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(findings, null, 2)}\n`, { mode: 0o600 })
}
