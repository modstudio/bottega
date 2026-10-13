#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['hub', 'orchestrator', 'shared']
const DIRECT_ARRAY_CAST = /\}::[a-z_]+\[\]/g
const SERIALIZED_JSONB_CAST = /\$\{JSON\.stringify\(.+\)\}\s*::(?:text\s*::\s*)?jsonb/g
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/
const violations: string[] = []

export function postgresBindingViolations(source: string, file: string): string[] {
  const found: string[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('#')
    )
      continue
    DIRECT_ARRAY_CAST.lastIndex = 0
    if (DIRECT_ARRAY_CAST.test(line)) found.push(`${file}:${index + 1}:array`)
    SERIALIZED_JSONB_CAST.lastIndex = 0
    if (SERIALIZED_JSONB_CAST.test(line)) found.push(`${file}:${index + 1}:jsonb`)
  }
  return found
}

for (const sourceRoot of SOURCE_ROOTS) {
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, sourceRoot) })) {
    if (relative.includes('node_modules/') || TEST_FILE.test(relative)) continue
    const file = join(sourceRoot, relative)
    violations.push(...postgresBindingViolations(readFileSync(join(ROOT, file), 'utf8'), file))
  }
}

for (const violation of violations) {
  const [file, line, kind] = violation.split(':')
  console.error(
    kind === 'jsonb'
      ? `${file}:${line}: refused JSON.stringify(...) bound directly to a jsonb cast; use bindJsonb(sql, value)`
      : `${file}:${line}: refused an interpolation immediately followed by '::<type>[]' on one line; use sql.array(values, type), or tx.array(values, type) inside a transaction`,
  )
}
if (violations.length) process.exit(1)

console.log('check-postgres-array-bindings: ok')
