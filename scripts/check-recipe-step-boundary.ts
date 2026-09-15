#!/usr/bin/env bun
/** Keep recipe step execution independent of lifecycle, persistence, claims, and register concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const file = 'orchestrator/src/recipe-step.ts'
const imports = importSpecifiers(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const allowed = new Set(['node:path', './recipe-schema.ts', './worktree-template.ts'])
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].filter(
  (specifier) => !allowed.has(specifier),
)
if (violations.length) {
  console.error(`check-recipe-step-boundary: ${file} imports ${violations.join(', ')}`)
  process.exit(1)
}
for (const expression of imports.unresolvedRelative) {
  console.error(`check-recipe-step-boundary: unresolved import at ${expression}`)
  process.exit(1)
}
console.log('check-recipe-step-boundary: ok')
