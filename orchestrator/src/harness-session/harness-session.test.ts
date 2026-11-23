import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessSessionDirectory } from '../../../shared/state-directory.ts'
import {
  publishHarnessSession,
  readHarnessSession,
  reapHarnessSessions,
  sweepHarnessSessions,
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

test('reaper removes a dead publication and keeps a live publication', () => {
  const env = state()
  for (const pid of [42, 43])
    publishHarnessSession({
      pid,
      session: `session-${pid}`,
      source: 'startup',
      env,
      observeStartTime: () => `start-${pid}`,
    })
  const result = reapHarnessSessions({
    env,
    identity: (pid) => (pid === 42 ? 'dead' : 'live'),
  })
  expect(result.reaped).toBe(1)
  expect(result.publications.map(({ identity }) => identity.pid)).toEqual([43])
  expect(readdirSync(harnessSessionDirectory(env))).toHaveLength(1)
})

test('sweep reports each live claude process without a matching publication', () => {
  const env = state()
  publishHarnessSession({
    pid: 42,
    session: 'published',
    source: 'resume',
    env,
    observeStartTime: () => 'published-start',
  })
  const lines: string[] = []
  const fact = (pid: number, startTime: string, command: string) => ({
    pid,
    startTime,
    command,
    ppid: 1,
    pgid: pid,
    cpu: 0,
    ageSeconds: 1,
    cwd: null,
    cwdVerified: false,
  })
  const result = sweepHarnessSessions({
    dryRun: false,
    env,
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
    identity: () => 'live',
    snapshot: () => ({
      facts: [
        fact(42, 'published-start', '/usr/local/bin/claude -p'),
        fact(43, 'missing-start', 'claude'),
        fact(44, 'other-start', 'bun test'),
      ],
      error: null,
    }),
  })
  expect(result.unpublished).toEqual([{ pid: 43, startTime: 'missing-start' }])
  expect(lines).toEqual(['harness processes without a published session: 1', '  43 missing-start'])
})
