#!/usr/bin/env bun
/** Keep canon budget policy independent of every adapter and store. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/canon-budget.ts'
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [
  ...imports.specifiers,
  ...imports.typeOnlySpecifiers,
  ...imports.unresolvedRelative.map((expression) => `unresolved relative import at ${expression}`),
]
if (violations.length) {
  console.error(`check-canon-budget-boundary: ${violations.join(', ')}`)
  process.exit(1)
}
console.log('check-canon-budget-boundary: ok')
