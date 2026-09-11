#!/usr/bin/env bun
/** Keep worker MCP file provisioning independent of lifecycle and policy. */
import { readFileSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/worktree-mcp.ts'
const imports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...imports.specifiers, ...imports.typeOnlySpecifiers]
  .filter((specifier) => specifier.startsWith('.'))
  .map((specifier) => `${FILE} imports "${specifier}" (only node builtins are allowed)`)
for (const expression of imports.unresolvedRelative) violations.push(`${FILE} has an unresolved relative import at ${expression}`)
if (violations.length) {
  console.error(`check-worktree-mcp-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-worktree-mcp-boundary: ok')
