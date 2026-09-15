#!/usr/bin/env bun
/** Keep canon lint decisions pure and independent of filesystems, stores, commands, and processes. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/canon-lint.ts'
const ALLOWED = new Set([
  'node:path',
  '../../shared/canon-references.ts',
  '../../shared/ratchet.ts',
  './canon-budget.ts',
])
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => !ALLOWED.has(specifier))
  .map((specifier) => `${FILE} imports ${specifier}`)
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-canon-lint-boundary: ${violations.join(', ')}`)
  process.exit(1)
}
console.log('check-canon-lint-boundary: ok')
