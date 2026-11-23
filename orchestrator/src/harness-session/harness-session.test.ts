import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessSessionDirectory } from '../../../shared/state-directory.ts'
import {
  publishHarnessSession,
  readHarnessSession,
  reapHarnessSessions,
} from './harness-session.ts'

const roots: string[] = []
const state = () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-session-'))
  roots.push(root)
  return { BOTTEGA_STATE_HOME: root }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('publish and read round trip atomically replaces the current harness session', () => {
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

  expect(readHarnessSession(42, { env, identity: () => 'live' })?.session).toBe('after-clear')
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

test('read rejects a publication for a reused pid', () => {
  const env = state()
  publishHarnessSession({
    pid: 42,
    session: 'old-session',
    source: 'startup',
    env,
    observeStartTime: () => 'old-start',
  })
  expect(readHarnessSession(42, { env, identity: () => 'reused' })).toBeNull()
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
