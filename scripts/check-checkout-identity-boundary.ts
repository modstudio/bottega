#!/usr/bin/env bun
/** Keep checkout addressing independent of databases and lifecycle policy. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/checkout-identity.ts'
const ALLOWED = new Set(['./projects.ts', './git-environment.ts'])
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => specifier.startsWith('.') && !ALLOWED.has(specifier))
  .map(
    (specifier) =>
      `${FILE} imports "${specifier}" (only projects.ts and git-environment.ts are allowed)`,
  )
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-checkout-identity-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-checkout-identity-boundary: ok')
