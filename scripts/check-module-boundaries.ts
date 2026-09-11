#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { measuredSourceFiles } from './check-file-ceiling'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const MODULE_ROOT = /^(orchestrator|hub)\/src\//
const CONCERN = /^\/\/ concern: ([a-z0-9-]+)$/
const violations: string[] = []

for (const file of measuredSourceFiles().filter(({ path }) => MODULE_ROOT.test(path))) {
  const firstLine = readFileSync(file.absolute, 'utf8').split('\n', 1)[0]!
  const concern = firstLine.match(CONCERN)?.[1]
  if (!concern) continue
  const boundary = `scripts/check-${concern}-boundary.ts`
  if (!existsSync(resolve(ROOT, boundary))) {
    violations.push(`${file.path}: missing ${boundary} (architecture-rules 1)`)
  }
}

if (violations.length) {
  for (const violation of violations) console.error(violation)
  process.exit(1)
}

console.log('check-module-boundaries: ok')
