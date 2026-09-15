#!/usr/bin/env bun
/** Keep MCP command adapters independent of the run nucleus and the CLI: they compose concern modules for one verb and own no lifecycle. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/mcp-commands.ts'
const FORBIDDEN: [RegExp, string][] = [
  [/^\.\/run\.ts$/, 'the run nucleus'],
  [/^\.\/cli(?:[.-]|$)/, 'the CLI'],
  [/^\.\/program\.ts$/, 'the CLI program'],
  [/^\.\/commands\//, 'the CLI adapters'],
]
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers].flatMap((specifier) => {
  const concern = FORBIDDEN.find(([p]) => p.test(specifier))?.[1]
  return concern ? [`${FILE} imports "${specifier}" (${concern})`] : []
})
for (const expression of imports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(
    `check-mcp-commands-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`,
  )
  process.exit(1)
}
console.log('check-mcp-commands-boundary: ok')
