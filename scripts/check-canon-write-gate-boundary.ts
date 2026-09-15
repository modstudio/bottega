#!/usr/bin/env bun
/** Keep canon write decisions pure and independent of filesystems, stores, commands, and processes. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/canon-write-gate.ts'
const ALLOWED = new Set(['./canon-lint.ts'])
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => !ALLOWED.has(specifier))
  .map((specifier) => `${FILE} imports ${specifier}`)
for (const expression of imports.unresolvedRelative) {
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
}
if (violations.length) {
  console.error(`check-canon-write-gate-boundary: ${violations.join(', ')}`)
  process.exit(1)
}
console.log('check-canon-write-gate-boundary: ok')
