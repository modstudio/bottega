#!/usr/bin/env bun
/** Keep review verdicts independent of landing policy and run-chain ownership. */
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/review.ts'
const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []

const IMPORT = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g
for (const match of source.matchAll(IMPORT)) {
  const specifier = match[1]!
  if (/^\.\/landing(?:[.-]|$)/.test(specifier)) {
    violations.push(`${FILE} imports "${specifier}" (landing policy)`)
  }
}

const RUN_POLICY_COLUMNS = ['parent_run_id', 'worktree', 'branch_kept', 'failure_kind'] as const
const QUERY = /\.query\(\s*([`'"])([\s\S]*?)\1/g
for (const match of source.matchAll(QUERY)) {
  const sql = match[2]!
  for (const column of RUN_POLICY_COLUMNS) {
    if (new RegExp(`\\b${column}\\b`).test(sql)) {
      violations.push(`${FILE} reads run-policy column "${column}"`)
    }
  }
}

if (violations.length) {
  console.error(`check-review-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}

console.log('check-review-boundary: ok')
