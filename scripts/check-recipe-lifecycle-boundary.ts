#!/usr/bin/env bun
/** Keep lifecycle planning pure and independent of execution, persistence, filesystem, and the register. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const file = 'orchestrator/src/recipe-lifecycle.ts'
const imports = importSpecifiers(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const allowed = new Set(['./recipe-schema.ts', './recipe-step.ts'])
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].filter(
  (item) => !allowed.has(item),
)
if (violations.length) {
  console.error(`check-recipe-lifecycle-boundary: ${file} imports ${violations.join(', ')}`)
  process.exit(1)
}
for (const expression of imports.unresolvedRelative) {
  console.error(`check-recipe-lifecycle-boundary: unresolved import at ${expression}`)
  process.exit(1)
}
console.log('check-recipe-lifecycle-boundary: ok')
