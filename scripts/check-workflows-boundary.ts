#!/usr/bin/env bun
/** Keep workflow seeds dependent only on database transactions and review vocabulary. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/workflow-seeds.ts'
const ALLOWED = new Set(['./db.ts', './review-vocabulary.ts'])
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => specifier.startsWith('.') && !ALLOWED.has(specifier))
  .map((specifier) => `${FILE} imports "${specifier}" (workflow seeds may import only ./db.ts and ./review-vocabulary.ts)`)
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-workflows-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-workflows-boundary: ok')
