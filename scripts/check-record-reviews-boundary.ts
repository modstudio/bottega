#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const file = 'orchestrator/src/record-reviews.ts'
const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const imports = importSpecifiers(source)
const allowed = new Set(['bun', './record-runs.ts'])
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].filter(
  (value) => !allowed.has(value),
)
if (violations.length || imports.unresolvedRelative.length)
  throw new Error(`${file} has forbidden imports: ${violations.join(', ')}`)
console.log('check-record-reviews-boundary: ok')
