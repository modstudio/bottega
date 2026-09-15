#!/usr/bin/env bun
/** Keep review commands independent of runs, transports, routing by value, the CLI, and worktrees by value. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/review-commands.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run\.ts$/, 'runs'],
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/route\.ts$/, 'routing by value'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/worktree\.ts$/, 'worktrees by value'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].flatMap((specifier) => {
  const concern = FORBIDDEN.find(([p]) => p.test(specifier))?.[1]
  return concern ? [`${FILE} imports "${specifier}" (${concern})`] : []
})
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(
    `check-review-commands-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
  )
  process.exit(1)
}
console.log('check-review-commands-boundary: ok')
