#!/usr/bin/env bun
/** Keep MCP preflight independent of execution, transport, routing, and mutation. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/mcp-preflight.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run(?:[.-]|$)/, 'run state'], [/^\.\/transport(?:[.-]|$)/, 'transport'],
  [/^\.\/route(?:[.-]|$)/, 'routing'], [/^\.\/db(?:\.ts)?$/, 'database mutation'],
  [/^\.\/contract(?:[.-]|$)/, 'contract value import'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations: string[] = []
for (const specifier of imports.specifiers) {
  if (specifier === './run-process.ts') continue
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports "${specifier}" (${concern})`)
}
for (const specifier of imports.typeOnlySpecifiers) {
  if (/^\.\/contract(?:[.-]|$)/.test(specifier)) continue
  const concern = FORBIDDEN.find(([pattern]) => pattern.test(specifier))?.[1]
  if (concern) violations.push(`${FILE} imports type "${specifier}" (${concern})`)
}
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-mcp-preflight-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-mcp-preflight-boundary: ok')
