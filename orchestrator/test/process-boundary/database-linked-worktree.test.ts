import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

const sourceRoot = join(dirname(new URL(import.meta.url).pathname), '../../..')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-linked-database-'))
const main = join(fixtureRoot, 'main')
const linked = join(fixtureRoot, 'linked')
const liveStore = join(main, 'orchestrator', 'orch.db')
const hermeticHome = join(fixtureRoot, 'home')
mkdirSync(hermeticHome)
const { scrubbedGitEnv } = await import('../../src/worktree.ts')

const hermeticGitEnv = () => ({
  ...scrubbedGitEnv(),
  HOME: hermeticHome,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
})

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function invoke(
  cli: string, cwd: string, args: string[], explicit?: string,
  extra: Record<string, string> | boolean = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env, ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'linked-database-test',
  }
  delete env.ORCH_DB
  delete env.ORCH_DB_WRITE
  if (explicit) env.ORCH_DB = explicit
  Object.assign(env, extra === true ? { ORCH_DB_WRITE: '1' } : extra)
  return Bun.spawnSync([process.execPath, cli, ...args], {
    cwd, env, stdout: 'pipe', stderr: 'pipe',
  })
}

mkdirSync(main, { recursive: true })
cpSync(join(sourceRoot, 'orchestrator', 'src'), join(main, 'orchestrator', 'src'), { recursive: true })
cpSync(join(sourceRoot, 'orchestrator', 'migrations'), join(main, 'orchestrator', 'migrations'), { recursive: true })
cpSync(join(sourceRoot, 'shared'), join(main, 'shared'), { recursive: true })
symlinkSync(join(sourceRoot, 'node_modules'), join(main, 'node_modules'))
symlinkSync(join(sourceRoot, 'orchestrator', 'node_modules'), join(main, 'orchestrator', 'node_modules'))
git(main, 'init', '-b', 'main')
git(main, 'config', 'user.email', 'linked-test@example.invalid')
git(main, 'config', 'user.name', 'Linked Test')
git(main, 'add', '.')
git(main, 'commit', '-m', 'DEV-306 linked database fixture')

const mainCli = join(main, 'orchestrator', 'src', 'orch.ts')
const initialized = invoke(mainCli, main, ['init-db'], liveStore)
if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
const register = new Database(liveStore)
register.query('INSERT INTO project (name,path,stack,canon,settings) VALUES (?,?,NULL,1,?)')
  .run(PLATFORM_SLUG, main, '{}')
register.close()

git(main, 'worktree', 'add', '-b', 'technical/DEV-306-linked-test', linked)
const linkedCli = join(linked, 'orchestrator', 'src', 'orch.ts')

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

describe('linked-worktree database protection', () => {
  test('a store ahead of the binary journal is refused without changing it', () => {
    const store = new Database(liveStore)
    store.query(
      `INSERT INTO run
         (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status, session_id)
       VALUES ('2026-09-06T00:00:00.000Z','codex','implement','sha',1,'fixture','ok',?)`,
    ).run('linked-database-test')
    store.query("INSERT INTO orch_migrations (hash,created_at,version) VALUES ('future',9999999999999,'0001_future')").run()
    store.close()

    expect(existsSync(`${liveStore}-wal`)).toBe(false)
    expect(existsSync(`${liveStore}-shm`)).toBe(false)
    const before = readFileSync(liveStore)
    const runs = invoke(linkedCli, linked, ['runs'])
    expect(runs.exitCode).not.toBe(0)
    expect(runs.stderr.toString()).toContain('ahead of this binary')
    expect(runs.stderr.toString()).toContain('0001_future')
    expect(readFileSync(liveStore)).toEqual(before)
    expect(existsSync(`${liveStore}-wal`)).toBe(false)
    expect(existsSync(`${liveStore}-shm`)).toBe(false)
    const cleanup = new Database(liveStore)
    cleanup.exec("DELETE FROM orch_migrations WHERE version='0001_future'")
    cleanup.close()

    const score = invoke(linkedCli, linked, ['score', '1', 'full', 'right', 'faithful', '--note', 'no'])
    expect(score.exitCode).not.toBe(0)
    expect(score.stderr.toString()).toContain(
      'refusing to write run or project rows to the registered main store from a linked worktree',
    )
  })

  test('ORCH_DB naming the live store does not authorise a linked binary to write it', () => {
    const before = readFileSync(liveStore)
    const score = invoke(linkedCli, linked, ['score', '1', 'full', 'right', 'faithful', '--note', 'named'], liveStore)
    expect(score.exitCode).not.toBe(0)
    expect(score.stderr.toString()).toContain(
      'refusing to write run or project rows to the registered main store from a linked worktree',
    )
    expect(score.stderr.toString()).toMatch(/^invariant: .+$/m)
    expect(score.stderr.toString()).toMatch(/^cleared by: .+$/m)
    expect(readFileSync(liveStore)).toEqual(before)
    const read = invoke(linkedCli, linked, ['runs'], liveStore)
    expect(read.exitCode).toBe(0)
  })

  test('ORCH_DB_WRITE=1 is the operator\'s explicit insistence and opens the live store for writing', () => {
    const score = invoke(
      linkedCli, linked, ['score', '1', 'full', 'right', 'faithful', '--note', 'insisted'], liveStore,
      { ORCH_DB_WRITE: '1' },
    )
    expect(score.stderr.toString()).toBe('')
    expect(score.exitCode).toBe(0)
    const checked = new Database(liveStore, { readonly: true })
    const row = checked.query("SELECT note FROM score WHERE run_id = 1 AND note = 'insisted'").get()
    checked.close()
    expect(row).not.toBeNull()
  })

  test('held-open WAL sidecars remain visible and unchanged to the ordinary read-only open', () => {
    const writer = new Database(liveStore)
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
    writer.query(
      `INSERT INTO run
         (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('2026-09-06T00:00:00.000Z','codex','understand','wal',1,'wal-only-row','ok')`,
    ).run()
    expect(existsSync(`${liveStore}-wal`)).toBe(true)
    expect(existsSync(`${liveStore}-shm`)).toBe(true)
    const before = [liveStore, `${liveStore}-wal`].map((path) => readFileSync(path))
    try {
      const runs = invoke(linkedCli, linked, ['runs'])
      expect(runs.exitCode).toBe(0)
      expect(runs.stdout.toString()).toContain('wal-only-row')
      expect([liveStore, `${liveStore}-wal`].map((path) => readFileSync(path))).toEqual(before)
      expect(existsSync(`${liveStore}-wal`)).toBe(true)
      expect(existsSync(`${liveStore}-shm`)).toBe(true)
    } finally {
      writer.close()
    }
  })

  test('wait observes a dead process once and exits without terminalising its row', () => {
    const store = new Database(liveStore)
    const inserted = store.query(
      `INSERT INTO run
         (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status, pid)
       VALUES ('2026-09-06T00:00:00.000Z','codex','understand','dead',1,'dead-row','running',2147483647)
       RETURNING id`,
    ).get() as { id: number }
    store.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    store.close()
    rmSync(`${liveStore}-wal`, { force: true })
    rmSync(`${liveStore}-shm`, { force: true })
    const before = readFileSync(liveStore)
    const started = Date.now()

    const waited = invoke(linkedCli, linked, ['wait', String(inserted.id), '--timeout', '30'])
    expect(Date.now() - started).toBeLessThan(5_000)
    const report = `run ${inserted.id}: process gone, not terminalised (read-only linked worktree)`
    expect(waited.stderr.toString().split(report).length - 1).toBe(1)
    expect(waited.stderr.toString()).not.toContain('still running after')
    expect(readFileSync(liveStore)).toEqual(before)
    expect(existsSync(`${liveStore}-wal`)).toBe(false)
    expect(existsSync(`${liveStore}-shm`)).toBe(false)
    const checked = new Database(`${pathToFileURL(liveStore).href}?immutable=1`, { readonly: true })
    expect(checked.query('SELECT status FROM run WHERE id=?').get(inserted.id)).toEqual({ status: 'running' })
    checked.close()
  }, 90_000)

  test('explicit ORCH_DB locates a copy and allows writes but not schema migration from a linked binary', () => {
    const explicit = join(fixtureRoot, 'explicit.db')
    const refused = invoke(linkedCli, linked, ['init-db'], explicit)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toString()).toContain('cleared by: orch migrate')
    const init = invoke(mainCli, main, ['init-db'], explicit)
    expect(init.exitCode, init.stderr.toString()).toBe(0)
    const store = new Database(explicit)
    store.query(
      `INSERT INTO run
         (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status, session_id)
       VALUES ('2026-09-06T00:00:00.000Z','codex','implement','sha',1,'explicit','ok',?)`,
    ).run('linked-database-test')
    store.exec("UPDATE schema_meta SET value='force-migration' WHERE key='schema'")
    store.close()

    const score = invoke(
      linkedCli, linked,
      ['score', '1', 'full', 'right', 'faithful', '--note', 'explicit'], explicit,
    )
    expect(score.exitCode).toBe(0)
    expect(score.stderr.toString()).not.toContain('invariant:')
    const checked = new Database(explicit, { readonly: true })
    expect(checked.query('SELECT delivery, quality, fidelity FROM score WHERE run_id=1').get())
      .toEqual({ delivery: 'full', quality: 'right', fidelity: 'faithful' })
    expect(checked.query("SELECT value FROM schema_meta WHERE key='schema'").get())
      .toEqual({ value: 'force-migration' })
    checked.close()
  })

  test('explicit ORCH_DB does not authorize writes to the registered main store', () => {
    const store = new Database(liveStore)
    const inserted = store.query(
      `INSERT INTO run
         (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status, session_id)
       VALUES ('2026-09-07T00:00:00.000Z','codex','implement','guard',1,'guard','ok',?)
       RETURNING id`,
    ).get('linked-database-test') as { id: number }
    store.close()

    const refused = invoke(
      linkedCli, linked,
      ['score', String(inserted.id), 'full', 'right', 'faithful', '--note', 'refused'],
      liveStore,
    )
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toString()).toContain(
      'invariant: A linked-worktree binary cannot write lifecycle rows to the registered main store.',
    )
    expect(refused.stderr.toString()).toContain(
      'cleared by: orch <command> with ORCH_DB_WRITE=1, or set ORCH_DB to a scratch copy',
    )

    const allowed = invoke(
      linkedCli, linked,
      ['score', String(inserted.id), 'full', 'right', 'faithful', '--note', 'allowed'],
      liveStore, true,
    )
    expect(allowed.exitCode, allowed.stderr.toString()).toBe(0)
  })

  test('doctor reports the path and linked-worktree read-only mode', () => {
    const doctor = invoke(linkedCli, linked, ['doctor'])
    expect(doctor.exitCode).toBe(0)
    expect(doctor.stdout.toString()).toContain(`database       ${realpathSync(liveStore)}`)
    expect(doctor.stdout.toString()).toContain('open mode      read-only linked worktree')
  })
})
