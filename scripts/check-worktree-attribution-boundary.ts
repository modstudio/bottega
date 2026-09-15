#!/usr/bin/env bun
/** Keep attribution and extraction independent of lifecycle policy and transports. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/worktree-attribution.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/route(?:[.-]|$)/, 'routing'],
  [/^\.\/contract(?:[.-]|$)/, 'contracts'],
  [/^\.\/transport(?:[.-]|$)/, 'transport'],
  [/^\.\/run(?:[.-]|$)/, 'run state'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI adapters'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations: string[] = []
for (const specifier of [...imports.specifiers, ...imports.typeOnlySpecifiers]) {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
if (imports.specifiers.includes('./worktree.ts')) {
  violations.push(`${FILE} imports worktree.ts by value (only its Worktree type is allowed)`)
}
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-worktree-attribution-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-worktree-attribution-boundary: ok')
