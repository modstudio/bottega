#!/usr/bin/env bun
/** Keep the bought CLI grammar thin: program.ts and commands/ adapt argv to concern modules; they never reach back into the legacy switch or dispatch through the run nucleus. */
import { readFileSync, readdirSync } from 'node:fs'
import { importSpecifiers } from './import-scanner.ts'
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILES = ['orchestrator/src/program.ts', ...readdirSync(`${ROOT}/orchestrator/src/commands`).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => `orchestrator/src/commands/${name}`)]
const FORBIDDEN: [RegExp, string][] = [[/^\.{1,2}\/cli\.ts$/, 'the legacy CLI switch'], [/^\.{1,2}\/run\.ts$/, 'the run nucleus; dispatch goes through run-dispatch']]
const violations: string[] = []
for (const file of FILES) {
  const imports = importSpecifiers(readFileSync(`${ROOT}/${file}`, 'utf8'))
  for (const specifier of [...imports.specifiers, ...imports.typeOnlySpecifiers]) { const concern = FORBIDDEN.find(([p]) => p.test(specifier))?.[1]; if (concern) violations.push(`${file} imports "${specifier}" (${concern})`) }
  for (const expression of imports.unresolvedRelative) violations.push(`${file} has an unresolved relative import at ${expression}`)
}
if (violations.length) { console.error(`check-cli-boundary: ${violations.length} violation(s)\n${violations.map((v) => `  ${v}`).join('\n')}\n`); process.exit(1) }
console.log(`check-cli-boundary: ok (${FILES.length} files)`)
