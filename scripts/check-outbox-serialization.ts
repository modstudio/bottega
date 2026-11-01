#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const OUTBOX_PAYLOAD_WRITE = /INSERT\s+INTO\s+outbox\s*\(|UPDATE\s+outbox\s+SET\s+payload/i
const WRAPPER_IMPORT =
  /import\s*{[^}]*\bstringifyOutboxPayload\b[^}]*}\s*from\s*['"][^'"]*\/outbox-sanitize\.ts['"]/
const WRAPPER_CALL = /\bstringifyOutboxPayload\s*\(/
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/

export type OutboxSource = { file: string; source: string }

export function outboxSerializationViolations(files: readonly OutboxSource[]): string[] {
  const violations: string[] = []
  for (const { file, source } of files) {
    if (TEST_FILE.test(file) || !OUTBOX_PAYLOAD_WRITE.test(source)) continue
    if (WRAPPER_IMPORT.test(source) && WRAPPER_CALL.test(source)) continue
    const offset = source.search(OUTBOX_PAYLOAD_WRITE)
    const line = source.slice(0, offset).split('\n').length
    violations.push(
      `${file}:${line}: outbox payload writes must import and call stringifyOutboxPayload before enqueue`,
    )
  }
  return violations
}

function productionSources(): OutboxSource[] {
  return [...new Glob('orchestrator/src/**/*.ts').scanSync({ cwd: ROOT })].map((file) => ({
    file,
    source: readFileSync(join(ROOT, file), 'utf8'),
  }))
}

if (import.meta.main) {
  const violations = outboxSerializationViolations(productionSources())
  for (const violation of violations) console.error(violation)
  if (violations.length) process.exit(1)
  console.log('check-outbox-serialization: ok')
}
