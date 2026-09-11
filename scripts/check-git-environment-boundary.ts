#!/usr/bin/env bun
/** Keep hermetic git observation independent of lifecycle and policy concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/git-environment.ts'
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = imports.specifiers
  .filter((specifier) => specifier.startsWith('.') && !/^\.\/worktree(?:\.ts)?$/.test(specifier))
  .map((specifier) => `${FILE} imports "${specifier}" (only worktree.ts is allowed)`)
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-git-environment-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-git-environment-boundary: ok')
