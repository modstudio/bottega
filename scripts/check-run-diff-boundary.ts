#!/usr/bin/env bun
/** Keep run diff independent of run control, transports, routing, the CLI, and worktrees by value. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/run-diff.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run\.ts$/, 'run control'],
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/route\.ts$/, 'routing'],
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
    `check-run-diff-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
  )
  process.exit(1)
}
console.log('check-run-diff-boundary: ok')
