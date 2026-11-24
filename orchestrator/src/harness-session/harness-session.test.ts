import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessSessionDirectory } from '../../../shared/state-directory.ts'
import {
  publishHarnessSession,
  readHarnessSession,
  reapHarnessSessions,
} from './harness-session.ts'
import { HARNESS_SESSION_TEMP_GRACE_MS } from './harness-session-decision.ts'

const roots: string[] = []
const state = () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-session-'))
  roots.push(root)
  return { BOTTEGA_STATE_HOME: root }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('publish atomically replaces the current harness session', () => {
  const env = state()
  const observeStartTime = () => 'Mon Nov 23 10:00:00 2026'
  publishHarnessSession({
    pid: 42,
    session: 'before-clear',
    source: 'startup',
    env,
    observeStartTime,
  })
  publishHarnessSession({ pid: 42, session: 'after-clear', source: 'clear', env, observeStartTime })

  expect(reapHarnessSessions({ env, identity: () => 'live', dryRun: true }).publications).toEqual([
    expect.objectContaining({ session: 'after-clear' }),
  ])
  const directory = harnessSessionDirectory(env)
  expect(readdirSync(directory)).toHaveLength(1)
  const path = join(directory, readdirSync(directory)[0]!)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    session: 'after-clear',
    harness: 'claude-code',
    source: 'clear',
  })
})

test('reader returns only the publication for the requested process identity', () => {
  const env = state()
  publishHarnessSession({
    pid: 42,
    session: 'published-session',
    source: 'startup',
    env,
    observeStartTime: () => 'published-start',
  })

  expect(readHarnessSession({ pid: 42, startTime: 'published-start' }, env)?.session).toBe(
    'published-session',
  )
  expect(readHarnessSession({ pid: 42, startTime: 'other-start' }, env)).toBeNull()
})

test('reaper removes dead and reused publications and keeps a live publication', () => {
  const env = state()
  for (const pid of [42, 43, 44])
    publishHarnessSession({
      pid,
      session: `session-${pid}`,
      source: 'startup',
      env,
      observeStartTime: () => `start-${pid}`,
    })
  const result = reapHarnessSessions({
    env,
    identity: (pid) => (pid === 42 ? 'dead' : pid === 43 ? 'reused' : 'live'),
  })
  expect(result.reaped).toBe(2)
  expect(result.publications.map(({ identity }) => identity.pid)).toEqual([44])
  expect(readdirSync(harnessSessionDirectory(env))).toHaveLength(1)
})

test('reaper removes expired temporary publications and preserves in-flight ones', () => {
  const env = state()
  publishHarnessSession({
    pid: 42,
    session: 'live-session',
    source: 'startup',
    env,
    observeStartTime: () => 'live-start',
  })
  const directory = harnessSessionDirectory(env)
  const oldTemporary = join(directory, '.42-old.json.00000000-0000-4000-8000-000000000001.tmp')
  const youngTemporary = join(directory, '.42-young.json.00000000-0000-4000-8000-000000000002.tmp')
  writeFileSync(oldTemporary, 'old')
  writeFileSync(youngTemporary, 'young')
  const now = new Date('2026-11-23T12:00:00.000Z')
  const old = new Date(now.getTime() - HARNESS_SESSION_TEMP_GRACE_MS - 1)
  const young = new Date(now.getTime() - HARNESS_SESSION_TEMP_GRACE_MS + 1)
  utimesSync(oldTemporary, old, old)
  utimesSync(youngTemporary, young, young)

  const result = reapHarnessSessions({ env, identity: () => 'live', now })

  expect(result.reaped).toBe(1)
  expect(result.publications).toHaveLength(1)
  expect(existsSync(oldTemporary)).toBe(false)
  expect(existsSync(youngTemporary)).toBe(true)
})

test('reaper skips a temporary publication that disappears before stat', () => {
  const env = state()
  publishHarnessSession({
    pid: 42,
    session: 'live-session',
    source: 'startup',
    env,
    observeStartTime: () => 'live-start',
  })
  const directory = harnessSessionDirectory(env)
  const temporary = join(directory, '.42-race.json.00000000-0000-4000-8000-000000000003.tmp')
  writeFileSync(temporary, 'racing')

  const result = reapHarnessSessions({
    env,
    identity: () => 'live',
    stat: (path) => {
      if (path === temporary) {
        rmSync(path)
        throw Object.assign(new Error('temporary publication disappeared'), { code: 'ENOENT' })
      }
      return statSync(path)
    },
  })

  expect(result.reaped).toBe(0)
  expect(result.publications).toHaveLength(1)
})

test('reaper retains a publication when process identity is unknown', () => {
  const env = state()
  publishHarnessSession({
    pid: 42,
    session: 'unknown-session',
    source: 'startup',
    env,
    observeStartTime: () => 'unknown-start',
  })

  const result = reapHarnessSessions({ env, identity: () => 'unknown' })

  expect(result.reaped).toBe(0)
  expect(result.publications.map(({ session }) => session)).toEqual(['unknown-session'])
})

test('publish refuses a symlinked harness-session directory', () => {
  const env = state()
  const target = join(env.BOTTEGA_STATE_HOME, 'outside')
  mkdirSync(join(env.BOTTEGA_STATE_HOME, 'orchestrator'), { recursive: true })
  mkdirSync(target)
  symlinkSync(target, harnessSessionDirectory(env))

  expect(() =>
    publishHarnessSession({
      pid: 42,
      session: 'outside-session',
      source: 'startup',
      env,
      observeStartTime: () => 'outside-start',
    }),
  ).toThrow('harness session path is not a directory')
  expect(readdirSync(target)).toEqual([])
})
