#!/usr/bin/env bun
/** Enforce the record-cache concern boundary. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/record-cache.ts'
const ALLOWED = new Set(['bun:sqlite', './db.ts', './record-api-client.ts'])
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => !ALLOWED.has(specifier))
  .map((specifier) => `${FILE} imports "${specifier}"`)
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-record-cache-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-record-cache-boundary: ok')
