#!/usr/bin/env bun
/** Keep cleanup-sweep independent of transports, routing, reviews, contracts, the CLI, and durable execution. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/cleanup-sweep.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/route(?:[.-]|$)/, 'routing'],
  [/^\.\/review\.ts$/, 'reviews'],
  [/^\.\/contract\.ts$/, 'contract'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/run\.ts$/, 'durable execution'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations: string[] = []
for (const specifier of [...imports.specifiers, ...imports.typeOnlySpecifiers]) {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-cleanup-sweep-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-cleanup-sweep-boundary: ok')
