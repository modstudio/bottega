#!/usr/bin/env bun
/** Keep evidence assessment independent of execution and transaction ownership. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/evidence.ts'
const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/db(?:\.ts)?$/, 'database access'],
  [/^\.\/run(?:[.-]|$)/, 'the run state machine'],
  [/^\.\/landing(?:[.-]|$)/, 'landing'],
  [/^\.\/worktree(?:[.-]|$)/, 'worktrees'],
  [/^\.\/jobs(?:[.-]|$)/, 'jobs'],
]

const imports = importSpecifiers(source)
for (const specifier of imports.specifiers) {
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
for (const expression of imports.unresolvedRelative) {
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
}

const FORBIDDEN_CALLS: [RegExp, string][] = [
  [/\bdb\s*\(/, 'calls db('],
  [/\bwriteTransaction\s*\(/, 'calls writeTransaction('],
  [/\.transaction\s*\(/, 'begins a transaction'],
  [/\bBun\.spawn\b/, 'calls Bun.spawn'],
  [/\breadFileSync\b/, 'calls readFileSync'],
  [/\bwriteFileSync\b/, 'calls writeFileSync'],
]
for (const [pattern, message] of FORBIDDEN_CALLS) {
  if (pattern.test(source)) violations.push(`${FILE} ${message}`)
}

if (violations.length) {
  console.error(`check-evidence-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}

console.log('check-evidence-boundary: ok')
