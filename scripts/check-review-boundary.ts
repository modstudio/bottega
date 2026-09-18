#!/usr/bin/env bun
/** Keep review verdicts independent of landing policy and run-chain ownership. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const FILE = 'orchestrator/src/review/review.ts'
const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []
if (/\btryWriteContention\s*\(/.test(source)) {
  violations.push(`${FILE} calls tryWriteContention (machine-local coordination policy)`)
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
