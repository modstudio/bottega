#!/usr/bin/env bun
/** Keep dispatch command adapters independent of transports, routing, worktrees, the CLI, and reviews. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/dispatch-commands.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/route\.ts$/, 'routing'],
  [/^\.\/worktree\.ts$/, 'worktrees'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/review\.ts$/, 'reviews'],
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
    `check-dispatch-commands-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
  )
  process.exit(1)
}
console.log('check-dispatch-commands-boundary: ok')
