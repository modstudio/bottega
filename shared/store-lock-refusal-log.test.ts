import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV } from './state-directory.ts'
import { appendStoreLockRefusal, readStoreLockRefusalsSince } from './store-lock-refusal-log.ts'

const originalStateHome = process.env[STATE_HOME_ENV]
let stateHome = ''

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'store-lock-refusals-'))
  process.env[STATE_HOME_ENV] = stateHome
})

afterEach(() => {
  chmodSync(stateHome, 0o700)
  rmSync(stateHome, { recursive: true, force: true })
  if (originalStateHome === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHome
})

test('store lock refusals append, filter by time, and rotate to one previous file', () => {
  const facts = {
    store: '/state/hub/hub.db',
    holder: {
      pid: 4242,
      command: '/opt/bun /opt/hub/src/cli.ts record pull --watch --token secret',
    },
  }
  appendStoreLockRefusal(facts, ['task', 'set', 'DEV-1'], {
    now: new Date('2026-10-28T10:00:00.000Z'),
  })
  appendStoreLockRefusal(facts, ['note', 'new', 'words'], {
    now: new Date('2026-10-28T10:01:00.000Z'),
  })

  expect(readStoreLockRefusalsSince('2026-10-28T10:00:30.000Z')).toEqual([
    {
      at: '2026-10-28T10:01:00.000Z',
      store: '/state/hub/hub.db',
      holderCommand: 'bun cli.ts',
      holderPid: 4242,
      verb: 'note new',
    },
  ])

  appendStoreLockRefusal(facts, ['task', 'close'], {
    maxBytes: 1,
    now: new Date('2026-10-28T10:02:00.000Z'),
  })
  expect(readdirSync(stateHome).sort()).toEqual([
    'store-lock-refusals.jsonl',
    'store-lock-refusals.previous.jsonl',
  ])
  expect(readStoreLockRefusalsSince('2026-10-28T10:00:00.000Z')).toHaveLength(3)
})

test('an append failure in an unwritable state directory does not throw', () => {
  chmodSync(stateHome, 0o500)
  expect(() =>
    appendStoreLockRefusal(
      { store: '/state/orchestrator/orchestrator.db', holder: { unavailable: 'not sampled' } },
      ['run', 'start'],
    ),
  ).not.toThrow()
})

test('an unreadable refusal log names the path and cause', () => {
  const path = join(stateHome, 'store-lock-refusals.jsonl')
  mkdirSync(path)
  let failure: unknown
  try {
    readStoreLockRefusalsSince('2026-10-28T00:00:00.000Z')
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain(`store lock refusal log could not be read: ${path}`)
  expect((failure as Error).message).toContain('EISDIR')
})

test('an unparseable start time names the remedy', () => {
  expect(() => readStoreLockRefusalsSince('not-a-time')).toThrow(
    'cleared by: provide since as an ISO 8601 timestamp',
  )
})
