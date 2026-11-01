#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const INSERT_OUTBOX = /INSERT\s+INTO\s+outbox\s*\(/i
const SERIALIZER_IMPORT =
  /import\s*{[^}]*\bserializeOutboxPayload\b[^}]*}\s*from\s*['"][^'"]*\/outbox-serialize\.ts['"]/
const SERIALIZER_CALL = /\bserializeOutboxPayload\s*\(/
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/

export type OutboxSource = { file: string; source: string }

export function outboxSerializationViolations(files: readonly OutboxSource[]): string[] {
  const violations: string[] = []
  for (const { file, source } of files) {
    if (TEST_FILE.test(file) || !INSERT_OUTBOX.test(source)) continue
    if (SERIALIZER_IMPORT.test(source) && SERIALIZER_CALL.test(source)) continue
    const offset = source.search(INSERT_OUTBOX)
    const line = source.slice(0, offset).split('\n').length
    violations.push(
      `${file}:${line}: outbox inserts must import and call serializeOutboxPayload before enqueue`,
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
