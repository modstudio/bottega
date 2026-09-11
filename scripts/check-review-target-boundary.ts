#!/usr/bin/env bun
/** Keep review-target resolution independent of execution and mutation concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/review-target.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/transport(?:[.-]|$)/, 'transport'], [/^\.\/db(?:\.ts)?$/, 'database writes'],
  [/^\.\/contract(?:[.-]|$)/, 'contracts'], [/^\.\/route(?:[.-]|$)/, 'routing'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations: string[] = []
for (const specifier of imports.specifiers) {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-review-target-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-review-target-boundary: ok')
