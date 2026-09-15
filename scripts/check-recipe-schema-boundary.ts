#!/usr/bin/env bun
/** Keep the recipe schema pure and independent of file, register, and execution concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const file = 'orchestrator/src/recipe-schema.ts'
const imports = importSpecifiers(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const allowed = new Set(['zod'])
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].filter(
  (specifier) => !allowed.has(specifier),
)
if (violations.length) {
  console.error(`check-recipe-schema-boundary: ${file} imports ${violations.join(', ')}`)
  process.exit(1)
}
console.log('check-recipe-schema-boundary: ok')
