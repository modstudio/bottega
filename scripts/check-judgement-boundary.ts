#!/usr/bin/env bun
/** Keep judgement independent of transports, worktrees, routing, the CLI, durable execution, dispatch, and cleanup. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/judgement.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/transport(?:[.-]|$)/, 'transports'], [/^\.\/worktree(?:[.-]|$)/, 'worktrees'],
  [/^\.\/route(?:[.-]|$)/, 'routing'], [/^\.\/cli(?:[.-]|$)/, 'CLI'],
  [/^\.\/run\.ts$/, 'durable execution'], [/^\.\/run-dispatch\.ts$/, 'dispatch'],
  [/^\.\/cleanup(?:[.-]|$)/, 'cleanup'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations: string[] = []
for (const specifier of [...imports.specifiers, ...imports.typeOnlySpecifiers]) {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-judgement-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-judgement-boundary: ok')
