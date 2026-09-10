#!/usr/bin/env bun
/** Keep the isolation module independent of run policy and lifecycle concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/worktree.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/agents(?:[.-]|$)/, 'agents'],
  [/^\.\/jobs(?:[.-]|$)/, 'jobs'],
  [/^\.\/route(?:[.-]|$)/, 'routing'],
  [/^\.\/(?:score|scoring)(?:[.-]|$)/, 'scoring'],
  [/^\.\/review(?:[.-]|$)/, 'review'],
  [/^\.\/contract(?:[.-]|$)/, 'contracts'],
  [/^\.\/canon(?:[.-]|$)/, 'canon'],
  [/^\.\/run(?:[.-]|$)/, 'the run state machine'],
]

const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []
const imports = importSpecifiers(source)
for (const specifier of imports.specifiers) {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
for (const expression of imports.unresolvedRelative) {
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
}

if (violations.length) {
  console.error(`check-isolation-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}

console.log('check-isolation-boundary: ok')
