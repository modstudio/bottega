#!/usr/bin/env bun
/** Enforce the record-api-server concern boundary. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'orchestrator/src/record-api-server.ts'
const ALLOWED = new Set([
  './postgres-migrate.ts',
  './record-api.ts',
  './record-auth.ts',
  './record-runs.ts',
  './record-reviews.ts',
  './record-projects.ts',
])
const FORBIDDEN_FILES = new Set(['orchestrator/src/database-location.ts', 'orchestrator/src/db.ts'])
const entryImports = importSpecifiers(readFileSync(`${ROOT}/${FILE}`, 'utf8'))
const violations = [...entryImports.specifiers, ...entryImports.typeOnlySpecifiers]
  .filter((specifier) => !ALLOWED.has(specifier))
  .map((specifier) => `${FILE} imports "${specifier}"`)
for (const expression of entryImports.unresolvedRelative)
  violations.push(`${FILE} has an unresolved relative import at ${expression}`)

type PendingModule = { file: string; chain: string[] }
const pending: PendingModule[] = [{ file: FILE, chain: [FILE] }]
const visited = new Set<string>()

while (pending.length) {
  const current = pending.pop()!
  if (visited.has(current.file)) continue
  visited.add(current.file)
  const imports = importSpecifiers(readFileSync(`${ROOT}/${current.file}`, 'utf8'))
  for (const expression of imports.unresolvedRelative) {
    violations.push(
      `${current.file} has an unresolved relative import at ${expression}\n    chain: ${current.chain.join(' -> ')}`,
    )
  }
  for (const specifier of [...imports.specifiers, ...imports.typeOnlySpecifiers]) {
    if (specifier === 'bun:sqlite') {
      violations.push(`forbidden import chain: ${[...current.chain, specifier].join(' -> ')}`)
      continue
    }
    if (!specifier.startsWith('.')) continue
    const absolute = resolve(ROOT, dirname(current.file), specifier)
    const importedFile = relative(ROOT, absolute)
    const chain = [...current.chain, importedFile]
    if (!existsSync(absolute)) {
      violations.push(`unresolved relative import chain: ${chain.join(' -> ')}`)
      continue
    }
    if (FORBIDDEN_FILES.has(importedFile)) {
      violations.push(`forbidden import chain: ${chain.join(' -> ')}`)
      continue
    }
    pending.push({ file: importedFile, chain })
  }
}

if (violations.length) {
  console.error(`check-record-api-server-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-record-api-server-boundary: ok')
