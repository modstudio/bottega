import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, db } from '../test/fixture.ts'
import {
  classifyDivergence, freezeCheckout, indexIsUntrusted, parseConfinement, porcelainPaths,
  sessionForPid, UNTRUSTED_RETRY_WAIT_MS, type FrozenCheckout,
} from './confinement.ts'

const frozen = (over: Partial<FrozenCheckout> & Pick<FrozenCheckout, 'path'>): FrozenCheckout => ({
  project: 'fixture',
  status: '',
  head: 'main',
  expectedHead: 'main',
  indexTree: 'aaa',
  untrackedHash: 'bbb',
  headOid: '111',
  untrusted: false,
  ...over,
})

describe('porcelain path parsing', () => {
  test('splits -z entries and rename pairs', () => {
    expect(porcelainPaths(' M src/a.ts\0?? new.txt\0')).toEqual(['src/a.ts', 'new.txt'])
    expect(porcelainPaths('R  old.ts\0new.ts\0')).toEqual(['old.ts', 'new.ts'])
  })
})

describe('divergence classification', () => {
  test('an overlapping outside edit is overlapping', () => {
    const event = classifyDivergence({
      before: [frozen({ path: '/repo', status: '', indexTree: 'aaa' })],
      after: [frozen({ path: '/repo', status: ' M src/a.ts\0', indexTree: 'aaa' })],
      ownDiffPaths: ['src/a.ts', 'src/b.ts'],
      chainRoot: '111',
      database: db(),
      startedAt: '2026-09-07T10:00:00.000Z',
    })
    expect(event).toMatchObject({
      classification: 'overlapping',
      checkout: '/repo',
      attribution: 'unattributed',
      overlappingPaths: ['src/a.ts'],
      chainRoot: '111',
    })
  })

  test('a non-overlapping outside edit is not a failure class', () => {
    const event = classifyDivergence({
      before: [frozen({ path: '/repo', status: '' })],
      after: [frozen({ path: '/repo', status: '?? stray.txt\0', untrackedHash: 'ccc' })],
      ownDiffPaths: ['src/a.ts'],
      chainRoot: '111',
      database: db(),
      startedAt: '2026-09-07T10:00:00.000Z',
    })
    expect(event).toMatchObject({
      classification: 'non_overlapping',
      overlappingPaths: [],
      divergentPaths: ['stray.txt'],
    })
    const historical = { ...event }
    delete historical.checkout
    expect(parseConfinement(JSON.stringify(historical))?.checkout).toBeUndefined()
  })

  test('HEAD moved with a clean tree is an edit-commit cycle', () => {
    const event = classifyDivergence({
      before: [frozen({ path: '/repo', headOid: '111', indexTree: 'aaa' })],
      after: [frozen({ path: '/repo', headOid: '222', indexTree: 'ddd', status: '' })],
      ownDiffPaths: ['src/a.ts'],
      chainRoot: '111',
      database: db(),
      startedAt: '2026-09-07T10:00:00.000Z',
    })
    expect(event).toMatchObject({
      classification: 'edit_commit_cycle',
      overlappingPaths: [],
      tripTip: '222',
    })
  })

  test('unchanged freeze is not an event', () => {
    const snapshot = frozen({ path: '/repo' })
    expect(classifyDivergence({
      before: [snapshot], after: [snapshot], ownDiffPaths: ['src/a.ts'],
      chainRoot: '111', database: db(), startedAt: '2026-09-07T10:00:00.000Z',
    })).toBeNull()
  })

  test('a landing that moved HEAD is attributed from the landing table', () => {
    db().query(
      `INSERT INTO landing (project, branch, status, session_id, started_at, finished_at)
       VALUES ('fixture', 'DEV-372', 'landed', 'sess-land', ?, ?)`,
    ).run('2026-09-07T10:30:00.000Z', '2026-09-07T10:31:00.000Z')
    const event = classifyDivergence({
      before: [frozen({ path: '/repo', headOid: '111', indexTree: 'aaa' })],
      after: [frozen({ path: '/repo', headOid: '222', indexTree: 'ddd', status: '' })],
      ownDiffPaths: ['src/a.ts'],
      chainRoot: '111',
      database: db(),
      startedAt: '2026-09-07T10:00:00.000Z',
    })
    expect(event).toMatchObject({
      classification: 'edit_commit_cycle',
      attribution: 'landing',
      landingSession: 'sess-land',
    })
  })

  test('sessionForPid reads the run that holds that pid', () => {
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'running', session: 'sess-pid',
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4242, id)
    expect(sessionForPid(db(), 4242)).toBe('sess-pid')
    expect(sessionForPid(db(), 1)).toBeNull()
  })
})

describe('untrusted index sample', () => {
  test('a sample within one second of index mtime is re-taken', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-racy-index-'))
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked'), 'x\n')
    git('add', 'tracked')
    git('commit', '-m', 'seed')
    const index = join(repo, '.git', 'index')
    const now = Date.now()
    utimesSync(index, new Date(now), new Date(now))
    expect(indexIsUntrusted(repo, now)).toBe(true)
    let waited = 0
    const snapshot = freezeCheckout(
      { project: 'racy', path: repo, expectedHead: 'main' },
      { now, wait: (ms) => { waited = ms } },
    )
    expect(waited).toBe(UNTRUSTED_RETRY_WAIT_MS)
    expect(snapshot.headOid).toHaveLength(40)
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('symlinked tmpdir freeze', () => {
  test('freezes a checkout reached through a symlinked parent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'orch-symlink-parent-'))
    const real = join(parent, 'real')
    const link = join(parent, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    const repo = join(link, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'tracked'), 'x\n')
    git('add', 'tracked')
    git('commit', '-m', 'seed')
    chmodSync(repo, 0o755)
    const snapshot = freezeCheckout({ project: 'symlink', path: repo })
    expect(snapshot.indexTree).toBeTruthy()
    expect(snapshot.headOid).toHaveLength(40)
    rmSync(parent, { recursive: true, force: true })
  })
})
