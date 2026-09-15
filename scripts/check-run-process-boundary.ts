#!/usr/bin/env bun
/** Keep run process control independent of routing, contracts, reviews, and transports. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/run-process.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/route(?:[.-]|$)/, 'routing'],
  [/^\.\/contract(?:[.-]|$)/, 'contracts'],
  [/^\.\/review(?:[.-]|$)/, 'reviews'],
  [/^\.\/transport(?:[.-]|$)/, 'transport'],
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
  console.error(`check-run-process-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-run-process-boundary: ok')
