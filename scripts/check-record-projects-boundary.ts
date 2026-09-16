#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const file = 'orchestrator/src/record-projects.ts'
const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const imports = importSpecifiers(source)
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].filter(
  (value) => value !== 'bun',
)
if (violations.length || imports.unresolvedRelative.length)
  throw new Error(`${file} has forbidden imports: ${violations.join(', ')}`)
console.log('check-record-projects-boundary: ok')
