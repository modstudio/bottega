#!/usr/bin/env bun
/** Keep project commands independent of runs, routing, transports, reviews, the CLI, and worktrees by value. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/project-commands.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run\.ts$/, 'runs'],
  [/^\.\/route\.ts$/, 'routing'],
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/review\.ts$/, 'reviews'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/worktree\.ts$/, 'worktrees by value'],
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
  console.error(`check-project-commands-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-project-commands-boundary: ok')
