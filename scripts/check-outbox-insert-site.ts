#!/usr/bin/env bun
/** Outbox inserts and re-pending updates stay with owners that signal record sync. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PRODUCTION_ROOT = 'orchestrator/src'
const OUTBOX_INSERT_MODULE = 'orchestrator/src/record/outbox-enqueue.ts'
const DIRECT_OUTBOX_INSERT = /\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+outbox\b/gi
const OUTBOX_UPDATE =
  /\bUPDATE\s+outbox\s+SET\b(?<assignments>(?:(?!\bWHERE\b)[\s\S])*?)\bWHERE\b/gi
const OUTBOX_WRITE_OWNERS = [
  {
    assignment: /\bpayload\s*=/i,
    owners: [OUTBOX_INSERT_MODULE, 'orchestrator/src/record/outbox-prune.ts'],
  },
  { assignment: /\battempts\s*=\s*0\b/i, owners: [OUTBOX_INSERT_MODULE] },
  {
    assignment: /\bquarantined_at\s*=\s*NULL\b/i,
    owners: [OUTBOX_INSERT_MODULE, 'orchestrator/src/record/outbox-quarantine.ts'],
  },
] as const

const ownerMessage = (owners: readonly string[]): string =>
  `use ${owners.map((owner) => owner.replace(/^orchestrator\/src\//, '')).join(' or ')}`

export function directOutboxInsertViolations(source: string, file: string): string[] {
  const violations: string[] = []
  if (file !== OUTBOX_INSERT_MODULE) {
    for (const match of source.matchAll(DIRECT_OUTBOX_INSERT)) {
      const line = source.slice(0, match.index).split('\n').length
      violations.push(`${file}:${line}: ${ownerMessage([OUTBOX_INSERT_MODULE])}`)
    }
  }
  for (const update of source.matchAll(OUTBOX_UPDATE)) {
    const assignments = update.groups?.assignments ?? ''
    const refused = OUTBOX_WRITE_OWNERS.filter(
      ({ assignment, owners }) => assignment.test(assignments) && !owners.includes(file as never),
    )
    if (refused.length === 0) continue
    const line = source.slice(0, update.index).split('\n').length
    const owners = [...new Set(refused.flatMap(({ owners }) => owners))]
    violations.push(`${file}:${line}: ${ownerMessage(owners)}`)
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
    console.error(`${violation}: direct outbox insert or re-pending update refused`)
  }
  if (violations.length) process.exit(1)
  console.log('check-outbox-insert-site: ok')
}
