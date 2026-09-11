#!/usr/bin/env bun
/** Keep health command adapters independent of runs, routing, transports, the CLI, and worktrees. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/health-commands.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run\.ts$/, 'runs'],
  [/^\.\/route\.ts$/, 'routing'],
  [/^\.\/transport(?:[.-]|$)/, 'transports'],
  [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/worktree\.ts$/, 'worktrees'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].flatMap((specifier) => {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  return concern ? [`${FILE} imports "${specifier}" (${concern})`] : []
})
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) { console.error(`check-health-commands-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`); process.exit(1) }
console.log('check-health-commands-boundary: ok')

