#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { canonGitRoot, collectCanonLintInput } from '../src/canon/canon-files.ts'
import { canonRuleLevel, introducedCanonFindings, lintCanon } from '../src/canon/canon-lint.ts'

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
const result = lintCanon(collectCanonLintInput(root))
const introduced = introducedCanonFindings(baseline, result.findings)
const errors = introduced.filter(({ rule }) => canonRuleLevel(rule) === 'error')
const warnings = introduced.filter(({ rule }) => canonRuleLevel(rule) === 'warning')

for (const finding of warnings) {
  console.error(
    `canon lint warning: ${finding.file}:${finding.line} ${finding.rule} ${finding.message}`,
  )
}

if (errors.length) {
  console.error(`canon lint failed: ${errors.length} introduced finding(s)`)
  for (const finding of errors) {
    console.error(`${finding.file}:${finding.line} ${finding.rule} ${finding.message}`)
  }
  process.exit(1)
}

console.log(`canon lint ok (${result.findings.length} baselined finding(s))`)
