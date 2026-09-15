#!/usr/bin/env bun
/** Enforce the clock concern boundary: a primitive that imports nothing. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/clock.ts'
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [
  ...imports.specifiers.filter((specifier) => specifier.startsWith('.')),
  ...imports.typeOnlySpecifiers.filter((specifier) => specifier.startsWith('.')),
  ...imports.unresolvedRelative,
]
if (violations.length) {
  console.error(`check-clock-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations)
    console.error(`  ${FILE} imports ${JSON.stringify(violation)}\n`)
  process.exit(1)
}
console.log('check-clock-boundary: ok')
