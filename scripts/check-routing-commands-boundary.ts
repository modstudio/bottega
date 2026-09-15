#!/usr/bin/env bun
/** Keep routing command adapters independent of runs, transports, the CLI, worktrees, and reviews by value. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/routing-commands.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run\.ts$/, 'runs'],
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/worktree\.ts$/, 'worktrees'],
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
    `check-routing-commands-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
  )
  process.exit(1)
}
console.log('check-routing-commands-boundary: ok')
