import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../database/db.ts'
import {
  legacyLockDirectoryAgeMs,
  projectLockState,
  withWorktreeCreateLock,
} from './project-lock.ts'

const roots: string[] = []
let spawnSpy: ReturnType<typeof spyOn> | null = null

afterEach(() => {
  spawnSpy?.mockRestore()
  spawnSpy = null
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repository(processStartTime: string | null = null): string {
  const root = mkdtempSync(join(tmpdir(), 'orch-project-lock-'))
  roots.push(root)
  mkdirSync(join(root, '.git'))
  spawnSpy = spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[]) => {
    if (argv[0] === 'git') return spawnResult('.git\n')
    if (argv[0] === 'ps')
      return spawnResult(processStartTime ? `${processStartTime}\n` : 'unknown\n')
    throw new Error(`unexpected child process: ${argv.join(' ')}`)
  }) as typeof Bun.spawnSync)
  return root
}

function spawnResult(stdout: string): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

function waiterDirectory(root: string, kind: 'legacy' | 'kernel' = 'legacy'): string {
  const waiters = join(root, '.git', 'orch', 'locks', 'orch-create.waiters')
  const directory = kind === 'legacy' ? join(waiters, '.legacy') : waiters
  mkdirSync(directory, { recursive: true })
  return directory
}

function writeWaiter(
  directory: string,
  name: string,
  participant: {
    pid?: number
    startTime: string | null
    session?: string | null
    what?: string
    since?: string
  },
): string {
  const path = join(directory, name)
  writeFileSync(
    path,
    `${JSON.stringify({
      pid: participant.pid ?? process.pid,
      startTime: participant.startTime,
      incarnation: 'test-incarnation',
      session: participant.session ?? 'test-session',
      what: participant.what ?? 'test waiter',
      since: participant.since ?? '2026-10-16T12:00:00.000Z',
    })}\n`,
  )
  return path
}

function latestCreateTimeoutCause(): string {
  return db()
    .query<{ cause: string }, []>(
      "SELECT cause FROM contention WHERE resource_kind='lock' AND resource_key='create' AND event_kind='timeout' ORDER BY at,record_id DESC LIMIT 1",
    )
    .get()!.cause
}

test('state filters a reused-pid waiter read-only and acquisition reaps it', () => {
  const root = repository('Thu Oct 16 12:00:00 2026')
  const file = writeWaiter(waiterDirectory(root), '0000000000000001-reused', {
    startTime: 'Thu Oct 16 11:00:00 2026',
  })

  expect(projectLockState(root, 'create').waiters).toEqual([])
  expect(existsSync(file)).toBe(true)

  expect(withWorktreeCreateLock(root, () => 'acquired')).toBe('acquired')
  expect(existsSync(file)).toBe(false)
})

test.each([
  ['matching', 'Thu Oct 16 12:00:00 2026', 'Thu Oct 16 12:00:00 2026'],
  ['unknown recorded', 'Thu Oct 16 12:00:00 2026', null],
  ['unknown observed', null, 'Thu Oct 16 12:00:00 2026'],
] as const)(
  'project lock state keeps a live waiter with %s start time',
  (_, observed, recorded) => {
    const root = repository(observed)
    const file = writeWaiter(waiterDirectory(root, 'kernel'), '0000000000000001-live', {
      startTime: recorded,
    })

    expect(projectLockState(root, 'create').waiters).toHaveLength(1)
    expect(existsSync(file)).toBe(true)
  },
)

test('state filters a dead waiter read-only and acquisition reaps it', () => {
  const root = repository()
  const file = writeWaiter(waiterDirectory(root, 'kernel'), '0000000000000001-dead', {
    pid: 2_147_483_647,
    startTime: null,
  })

  expect(projectLockState(root, 'create').waiters).toEqual([])
  expect(existsSync(file)).toBe(true)

  expect(withWorktreeCreateLock(root, () => 'acquired')).toBe('acquired')
  expect(existsSync(file)).toBe(false)
})

test('legacy FIFO timeout names the holder and head waiter separately', () => {
  const root = repository()
  const directory = waiterDirectory(root)
  const legacy = join(root, '.git', 'orch-create.lock')
  mkdirSync(legacy)
  writeWaiter(legacy, 'owner', {
    startTime: null,
    session: 'holder-session',
    what: 'active provisioning',
    since: '2026-10-16T11:00:00.000Z',
  })
  writeFileSync(join(directory, '.ticket'), '1\n')
  writeWaiter(directory, '0000000000000001-head', {
    startTime: null,
    session: 'head-session',
    what: 'cleanup attribution',
    since: '2026-10-16T12:00:00.000Z',
  })

  let message = ''
  try {
    withWorktreeCreateLock(root, () => undefined, 0)
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toContain(
    `holder session holder-session, pid ${process.pid}, active provisioning`,
  )
  expect(message).toContain(
    `head waiter pid ${process.pid}, session head-session, cleanup attribution, since 2026-10-16T12:00:00.000Z`,
  )
  expect(message).toContain(
    `head waiter pid ${process.pid}: its ticket clears when that waiter finishes or is reaped once provably stale`,
  )
  expect(latestCreateTimeoutCause()).toContain(
    `holder session holder-session, pid ${process.pid}, active provisioning; head waiter pid ${process.pid}, session head-session`,
  )
})

test('legacy timeout names an ownerless lock directory and its age', () => {
  const root = repository()
  const legacy = join(root, '.git', 'orch-create.lock')
  mkdirSync(legacy)
  const old = new Date(Date.now() - 5_000)
  utimesSync(legacy, old, old)

  expect(() => withWorktreeCreateLock(root, () => undefined, 0)).toThrow(
    /legacy lock directory exists with no owner \(age \d+s\)/,
  )
  expect(latestCreateTimeoutCause()).toMatch(
    /legacy lock directory exists with no owner \(age \d+s\)/,
  )
  expect(existsSync(legacy)).toBe(true)
})

test('legacy acquisition retries when an ownerless directory disappears before stat', () => {
  const root = repository()
  const legacy = join(root, '.git', 'orch-create.lock')
  mkdirSync(legacy)
  let removed = false
  expect(
    legacyLockDirectoryAgeMs(legacy, () => {
      removed = true
      rmSync(legacy, { recursive: true })
    }),
  ).toBeNull()

  expect(withWorktreeCreateLock(root, () => 'acquired', 0)).toBe('acquired')
  expect(removed).toBe(true)
})
