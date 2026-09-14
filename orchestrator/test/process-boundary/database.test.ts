// Tests fresh-process database selection and startup writes.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { applySchema } from '../../src/db.ts'

const inheritedEnvironment = {
  ORCH_DB: process.env.ORCH_DB,
  ORCH_DEPTH: process.env.ORCH_DEPTH,
  CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
}

afterEach(() => {
  for (const [name, value] of Object.entries(inheritedEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
describe('read-only orchestrator database', () => {
  const CLI = new URL('../../src/orch.ts', import.meta.url).pathname

  const fixture = (withHeartbeat = true) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'orch-readonly-'))
    const path = join(fixtureDir, 'orch.db')
    const d = new Database(path)
    applySchema(d)
    if (!withHeartbeat) d.exec('DROP TABLE session_seen')
    d.close()
    return { fixtureDir, path }
  }

  const invoke = (path: string, command: string | readonly string[]) => Bun.spawnSync(
    [process.execPath, CLI, ...(Array.isArray(command) ? command : [command])],
    {
      env: {
        ...process.env,
        ORCH_DB: path,
        ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'read-only-test-session',
      },
      stdout: 'pipe', stderr: 'pipe',
    },
  )

  test('jobs and inbox serve reads without stamping a chmod-444 database', () => {
    const { fixtureDir, path } = fixture()
    chmodSync(path, 0o444)
    try {
      for (const command of ['jobs', 'inbox', ['review', 'list', '--json'], ['review', 'calibration', '--json']] as const) {
        const p = invoke(path, command)
        expect(p.exitCode, `${JSON.stringify(command)}: ${p.stderr.toString()}`).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const readonly = new Database(path, { readonly: true })
      expect(readonly.query('SELECT COUNT(*) n FROM session_seen').get()).toEqual({ n: 0 })
      readonly.close()
    } finally {
      chmodSync(path, 0o644)
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('a read-only database missing session_seen still serves jobs and inbox', () => {
    const { fixtureDir, path } = fixture(false)
    chmodSync(path, 0o444)
    try {
      for (const command of ['jobs', 'inbox', ['review', 'list', '--json'], ['review', 'calibration', '--json']] as const) {
        const p = invoke(path, command)
        expect(p.exitCode, `${JSON.stringify(command)}: ${p.stderr.toString()}`).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const readonly = new Database(path, { readonly: true })
      expect(readonly.query(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_seen'`,
      ).get()).toBeNull()
      readonly.close()
    } finally {
      chmodSync(path, 0o644)
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('a writable database keeps stamping the current session', () => {
    const { fixtureDir, path } = fixture()
    try {
      for (const command of ['jobs', 'inbox'] as const) {
        const p = invoke(path, command)
        expect(p.exitCode).toBe(0)
        expect(p.stderr.toString()).toBe('')
      }
      const writable = new Database(path)
      expect(writable.query(
        'SELECT session_id FROM session_seen WHERE session_id=?',
      ).get('read-only-test-session')).toEqual({ session_id: 'read-only-test-session' })
      writable.close()
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('coverage audit leaves the database bytes unchanged and creates no WAL', () => {
    const { fixtureDir, path } = fixture()
    const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = digest()
    try {
      expect(existsSync(`${path}-wal`)).toBe(false)
      const p = Bun.spawnSync([process.execPath, CLI, 'review', 'coverage-audit', '--json'], {
        env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).toBe('')
      expect(JSON.parse(p.stdout.toString())).toEqual({
        count: 0, review_ids: [], partial_review_ids: [],
      })
      expect(digest()).toBe(before)
      expect(existsSync(`${path}-wal`)).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

})
