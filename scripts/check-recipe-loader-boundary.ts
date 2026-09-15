#!/usr/bin/env bun
/** Keep tracked recipe loading independent of execution, persistence, and CLI concerns. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const file = 'orchestrator/src/recipe-loader.ts'
const imports = importSpecifiers(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const forbidden = [/^\.\/projects\.ts$/, /^\.\/recipe\.ts$/, /^\.\/db\.ts$/, /^\.\/cli(?:[.-]|$)/]
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].filter((specifier) =>
  forbidden.some((pattern) => pattern.test(specifier)),
)
if (violations.length) {
  console.error(`check-recipe-loader-boundary: ${file} imports ${violations.join(', ')}`)
  process.exit(1)
}
for (const expression of imports.unresolvedRelative) {
  console.error(`check-recipe-loader-boundary: unresolved import at ${expression}`)
  process.exit(1)
}
console.log('check-recipe-loader-boundary: ok')
