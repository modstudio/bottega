#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonGitRoot, collectCanonFiles } from '../src/canon-files.ts'
import { introducedCanonFindings, lintCanon } from '../src/canon-lint.ts'

const findingSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  rule: z.string(),
  message: z.string(),
  measuredBytes: z.number().int().nonnegative().optional(),
})

const root = canonGitRoot(process.cwd())
const baselinePath = join(root, 'scripts/quality/canon-lint.json')
const baseline = findingSchema.array().parse(JSON.parse(readFileSync(baselinePath, 'utf8')))
const result = lintCanon({ files: collectCanonFiles(root) })
const introduced = introducedCanonFindings(baseline, result.findings)

if (introduced.length) {
  console.error(`canon lint failed: ${introduced.length} introduced finding(s)`)
  for (const finding of introduced) {
    console.error(`${finding.file}:${finding.line} ${finding.rule} ${finding.message}`)
  }
  process.exit(1)
}

console.log(`canon lint ok (${result.findings.length} baselined finding(s))`)
