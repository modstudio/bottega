#!/usr/bin/env bun
/** Outbox rows enter through one writer so every enqueue signals record sync. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PRODUCTION_ROOT = 'orchestrator/src'
const OUTBOX_INSERT_MODULE = 'orchestrator/src/record/outbox-enqueue.ts'
const DIRECT_OUTBOX_INSERT = /\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+outbox\b/gi

export function directOutboxInsertViolations(source: string, file: string): string[] {
  if (file === OUTBOX_INSERT_MODULE) return []
  const violations: string[] = []
  for (const match of source.matchAll(DIRECT_OUTBOX_INSERT)) {
    const line = source.slice(0, match.index).split('\n').length
    violations.push(`${file}:${line}`)
  }
  return violations
}

if (import.meta.main) {
  const violations: string[] = []
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, PRODUCTION_ROOT) })) {
    if (relative.endsWith('.test.ts')) continue
    const file = join(PRODUCTION_ROOT, relative)
    violations.push(...directOutboxInsertViolations(readFileSync(join(ROOT, file), 'utf8'), file))
  }

  for (const violation of violations) {
    console.error(`${violation}: direct outbox insert refused; use insertOutboxRow`)
  }
  if (violations.length) process.exit(1)
  console.log('check-outbox-insert-site: ok')
}
