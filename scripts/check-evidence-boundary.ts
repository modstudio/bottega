#!/usr/bin/env bun
/** Keep evidence assessment independent of execution and transaction ownership. */
import { readFileSync } from 'node:fs'
import { importSpecifiers, repositoryRelativeImport } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/evidence.ts'
const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []
const FORBIDDEN: [RegExp, string][] = [
  [/^orchestrator\/src\/db(?:\/db)?(?:\.ts)?$/, 'database access'],
  [/^orchestrator\/src\/run(?:[./-]|$)/, 'the run state machine'],
  [/^orchestrator\/src\/landing(?:[./-]|$)/, 'landing'],
  [/^orchestrator\/src\/worktree(?:[./-]|$)/, 'worktrees'],
  [/^orchestrator\/src\/jobs(?:[./-]|$)/, 'jobs'],
]

const imports = importSpecifiers(source)
for (const specifier of imports.specifiers) {
  const resolved = repositoryRelativeImport(FILE, specifier)
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(resolved))?.[1]
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
