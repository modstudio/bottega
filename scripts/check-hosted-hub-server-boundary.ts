#!/usr/bin/env bun
/** Enforce the hosted hub server concern boundary. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = 'hub/src/hosted.ts'
const FORBIDDEN_FILES = new Set(['hub/src/db.ts', 'hub/src/orch.ts'])
const SPAWN_PATTERN =
  /\bbun:sqlite\b|\bBun\.spawn(?:Sync)?\s*\(|\b(?:from|require\s*\()\s*['"](?:node:)?child_process['"]/

type PendingModule = { file: string; chain: string[] }
const pending: PendingModule[] = [{ file: FILE, chain: [FILE] }]
const visited = new Set<string>()
const violations: string[] = []

while (pending.length) {
  const current = pending.pop()!
  if (visited.has(current.file)) continue
  visited.add(current.file)
  const source = readFileSync(`${ROOT}/${current.file}`, 'utf8')
  if (SPAWN_PATTERN.test(source)) {
    violations.push(`forbidden spawn or sqlite in import chain: ${current.chain.join(' -> ')}`)
  }
  const imports = importSpecifiers(source)
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
  console.error(`check-hosted-hub-server-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-hosted-hub-server-boundary: ok')
