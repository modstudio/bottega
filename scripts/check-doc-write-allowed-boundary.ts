#!/usr/bin/env bun
/** Keep document write decisions independent of stores, HTTP, filesystems, and CLI. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/doc-write-allowed.ts'
const ALLOWED = new Set([
  './canon-hydrate.ts',
  './canon-write-gate.ts',
  './canon-lint.ts',
  './pack-budget.ts',
])
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => !ALLOWED.has(specifier))
  .map((specifier) => `${FILE} imports "${specifier}"`)
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-doc-write-allowed-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-doc-write-allowed-boundary: ok')
