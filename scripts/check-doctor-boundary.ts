#!/usr/bin/env bun
/** Keep doctor independent of transports, routing, run control, the CLI, and reviews by value. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/doctor.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/route\.ts$/, 'routing'],
  [/^\.\/run\.ts$/, 'run control'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/review\.ts$/, 'reviews by value'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].flatMap((specifier) => {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  return concern ? [`${FILE} imports "${specifier}" (${concern})`] : []
})
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(
    `check-doctor-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
  )
  process.exit(1)
}
console.log('check-doctor-boundary: ok')
