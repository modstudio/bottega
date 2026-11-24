import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  addCandidate,
  createHookFixture,
  removeHookFixtures,
  runHook,
} from '../../test/fixtures/board-hook.ts'

const interruptHook = resolve(import.meta.dir, '../../hooks/board-interrupt.py')
const guardHook = resolve(import.meta.dir, '../../hooks/board-ack-guard.py')

afterEach(removeHookFixtures)

test('PostToolUse treats a stopped pending read like the former command failure', () => {
  const stopped = createHookFixture(
    '{"delivery":[],"overflow":null,"pendingAcknowledgements":[],"warning":"hosted board delivery stopped","stopped":"hosted board delivery stopped"}',
  )
  addCandidate(stopped, 1)
  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), stopped)

  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe('')
  const markerRoot = join(stopped.root, 'board-hook-state', 'interrupt')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
    candidate_ids: [],
    ran_at: 0,
    injected_at: {},
  })
})

test('PostToolUse injects a successful delivery carrying a deferred-successor warning', () => {
  const warning = createHookFixture(
    '{"delivery":[{"id":"7","text":"reply successor","requiresAcknowledgement":false}],"overflow":null,"pendingAcknowledgements":[],"warning":"1 reply successor remains queued; run board pending again","stopped":null}',
  )
  addCandidate(warning, 1)

  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), warning)

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toBe(
    'reply successor',
  )
})

test('Stop keeps its acknowledgement counter when pending is stopped', () => {
  const stopped = createHookFixture(
    '{"delivery":[],"overflow":null,"pendingAcknowledgements":[],"warning":"hosted board delivery stopped","stopped":"hosted board delivery stopped"}',
  )
  const markerRoot = join(stopped.root, 'board-hook-state', 'stop')
  mkdirSync(markerRoot, { recursive: true })
  const marker = join(markerRoot, createHash('sha256').update('reader').digest('hex'))
  writeFileSync(marker, JSON.stringify({ blocks: 2 }))

  const result = runHook(guardHook, JSON.stringify({ session_id: 'reader' }), stopped)

  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe('')
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ blocks: 2 })
})

test('Stop counts acknowledgements when a successful delivery carries a deferred-successor warning', () => {
  const warning = createHookFixture(
    '{"delivery":[],"overflow":null,"pendingAcknowledgements":[{"id":"8","text":"acknowledge me","requiresAcknowledgement":true}],"warning":"1 reply successor remains queued; run board pending again","stopped":null}',
  )

  const result = runHook(guardHook, JSON.stringify({ session_id: 'reader' }), warning)

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).decision).toBe('block')
  const markerRoot = join(warning.root, 'board-hook-state', 'stop')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ blocks: 1 })
})
