#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['hub', 'orchestrator', 'shared']
const DIRECT_ARRAY_CAST = /\}::[a-z_]+\[\]/g
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/
const violations: string[] = []

for (const sourceRoot of SOURCE_ROOTS) {
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, sourceRoot) })) {
    if (relative.includes('node_modules/') || TEST_FILE.test(relative)) continue
    const file = join(sourceRoot, relative)
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      DIRECT_ARRAY_CAST.lastIndex = 0
      if (DIRECT_ARRAY_CAST.test(line)) violations.push(`${file}:${index + 1}`)
    }
  }
}

for (const violation of violations) {
  console.error(
    `${violation}: do not cast an interpolated value directly to a Postgres array; use the SQL client's array helper`,
  )
}
if (violations.length) process.exit(1)

console.log('check-postgres-array-bindings: ok')
