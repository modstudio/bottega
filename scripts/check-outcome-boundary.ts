#!/usr/bin/env bun
/** Keep outcome decisions and interpretation independent of lifecycle concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers, repositoryRelativeImport } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/outcome.ts'
const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []
const FORBIDDEN: [RegExp, string][] = [
  [/^orchestrator\/src\/agents(?:[./-]|$)/, 'agents'],
  [/^orchestrator\/src\/jobs(?:[./-]|$)/, 'jobs'],
  [/^orchestrator\/src\/route(?:[./-]|$)/, 'routing'],
  [/^orchestrator\/src\/(?:score|scoring)(?:[./-]|$)/, 'scoring'],
  [/^orchestrator\/src\/review(?:[./-]|$)/, 'review'],
  [/^orchestrator\/src\/contract(?:[./-]|$)/, 'contracts'],
  [/^orchestrator\/src\/canon(?:[./-]|$)/, 'canon'],
  [/^orchestrator\/src\/landing(?:[./-]|$)/, 'landing'],
  [/^orchestrator\/src\/worktree(?:[./-]|$)/, 'worktrees'],
  [/^orchestrator\/src\/database\/db\.ts$/, 'database'],
  [/^orchestrator\/src\/run(?:[./-]|$)/, 'the run state machine'],
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
  [/\.query\s*\(/, 'calls .query('],
  [/\bBun\.spawn\b/, 'calls Bun.spawn'],
  [/\breadFileSync\b/, 'calls readFileSync'],
  [/\bwriteFileSync\b/, 'calls writeFileSync'],
]
for (const [pattern, message] of FORBIDDEN_CALLS) {
  if (pattern.test(source)) violations.push(`${FILE} ${message}`)
}

if (violations.length) {
  console.error(`check-outcome-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}

console.log('check-outcome-boundary: ok')
