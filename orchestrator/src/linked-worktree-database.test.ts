import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = join(dirname(new URL(import.meta.url).pathname), '../..')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-linked-database-'))
const main = join(fixtureRoot, 'main')
const linked = join(fixtureRoot, 'linked')
const liveStore = join(main, 'orchestrator', 'orch.db')

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function invoke(cli: string, cwd: string, args: string[], explicit?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env, ORCH_DEPTH: '0', CLAUDE_CODE_SESSION_ID: 'linked-database-test',
  }
  delete env.ORCH_DB
  if (explicit) env.ORCH_DB = explicit
  return Bun.spawnSync([process.execPath, cli, ...args], {
    cwd, env, stdout: 'pipe', stderr: 'pipe',
  })
}

mkdirSync(main, { recursive: true })
cpSync(join(sourceRoot, 'orchestrator', 'src'), join(main, 'orchestrator', 'src'), { recursive: true })
cpSync(join(sourceRoot, 'shared'), join(main, 'shared'), { recursive: true })
git(main, 'init', '-b', 'main')
git(main, 'config', 'user.email', 'linked-test@example.invalid')
git(main, 'config', 'user.name', 'Linked Test')
git(main, 'add', '.')
git(main, 'commit', '-m', 'DEV-306 linked database fixture')

const mainCli = join(main, 'orchestrator', 'src', 'cli.ts')
const initialized = invoke(mainCli, main, ['init-db'], liveStore)
if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())

git(main, 'worktree', 'add', '-b', 'technical/DEV-306-linked-test', linked)
const linkedCli = join(linked, 'orchestrator', 'src', 'cli.ts')

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

describe('linked-worktree database protection', () => {
  test('newer live store stays byte-identical while reads work and writes refuse', () => {
    const store = new Database(liveStore)
    store.query(
      `INSERT INTO run
         (started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status, session_id)
       VALUES ('2026-09-06T00:00:00.000Z','codex','implement','sha',1,'fixture','ok',?)`,
    ).run('linked-database-test')
    store.exec("ALTER TABLE run ADD COLUMN future_evidence TEXT; UPDATE schema_meta SET value='future-binary' WHERE key='schema';")
    store.close()

    expect(existsSync(`${liveStore}-wal`)).toBe(false)
    expect(existsSync(`${liveStore}-shm`)).toBe(false)
    const before = readFileSync(liveStore)
    const runs = invoke(linkedCli, linked, ['runs'])
    expect(runs.exitCode).toBe(0)
    expect(runs.stdout.toString()).toContain('fixture')
    expect(runs.stderr.toString()).toContain('warning: canonical schema mismatch')

    const score = invoke(linkedCli, linked, ['score', '1', 'full', 'right', 'faithful', '--note', 'no'])
    expect(score.exitCode).not.toBe(0)
    expect(score.stderr.toString()).toContain(
      'refusing to write the live store from a linked worktree; set ORCH_DB explicitly ' +
      '(a copy for experiments, or the live path to insist)',
    )
    expect(readFileSync(liveStore)).toEqual(before)
    expect(existsSync(`${liveStore}-wal`)).toBe(false)
    expect(existsSync(`${liveStore}-shm`)).toBe(false)
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
  })

  test('explicit ORCH_DB keeps migration and writes enabled from the linked worktree', () => {
    const explicit = join(fixtureRoot, 'explicit.db')
    const init = invoke(linkedCli, linked, ['init-db'], explicit)
    expect(init.exitCode).toBe(0)
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
    const checked = new Database(explicit, { readonly: true })
    expect(checked.query('SELECT delivery, quality, fidelity FROM score WHERE run_id=1').get())
      .toEqual({ delivery: 'full', quality: 'right', fidelity: 'faithful' })
    expect(checked.query("SELECT value FROM schema_meta WHERE key='schema'").get())
      .not.toEqual({ value: 'force-migration' })
    checked.close()
  })

  test('doctor reports the path and linked-worktree read-only mode', () => {
    const doctor = invoke(linkedCli, linked, ['doctor'])
    expect(doctor.exitCode).toBe(0)
    expect(doctor.stdout.toString()).toContain(`database       ${realpathSync(liveStore)}`)
    expect(doctor.stdout.toString()).toContain('open mode      read-only linked worktree')
  })
})
