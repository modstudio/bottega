#!/usr/bin/env bun
/** Keep reply dialect resolution independent of lifecycle and impure transport concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers, repositoryRelativeImport } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/contract/contract.ts'
const source = readFileSync(`${ROOT}/${FILE}`, 'utf8')
const violations: string[] = []
const REVIEW_VOCABULARY_FILES = new Set([
  'orchestrator/src/review-vocabulary.ts',
  'orchestrator/src/review-vocabulary/review-vocabulary.ts',
  'orchestrator/src/review/review-vocabulary.ts',
])
const FORBIDDEN: [RegExp, string][] = [
  [/^orchestrator\/src\/run(?:[./-]|$)/, 'the run state machine'],
  [/^orchestrator\/src\/landing(?:[./-]|$)/, 'landing'],
  [/^orchestrator\/src\/review(?:[./-]|$)/, 'review'],
  [/^orchestrator\/src\/route(?:[./-]|$)/, 'routing'],
  [/^orchestrator\/src\/(?:score|scoring)(?:[./-]|$)/, 'scoring'],
  [/^orchestrator\/src\/canon(?:[./-]|$)/, 'canon'],
]

const imports = importSpecifiers(source)
for (const specifier of imports.specifiers) {
  const resolved = repositoryRelativeImport(FILE, specifier)
  if (REVIEW_VOCABULARY_FILES.has(resolved)) continue
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
  console.error(`check-contract-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}

console.log('check-contract-boundary: ok')
