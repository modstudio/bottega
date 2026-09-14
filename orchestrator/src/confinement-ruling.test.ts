import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { clearConfinement } from './confinement-ruling.ts'
import { refuseEscapedChain } from './run-control.ts'

beforeEach(() => { process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session' })

function fixture(kind: 'escaped' | 'confinement_unverified' = 'escaped') {
  const repo = cloneRepository('orch-confinement-ruling-')
  const git = (cwd: string, ...args: string[]) => {
    const child = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (child.exitCode !== 0) throw new Error(child.stderr.toString())
    return child.stdout.toString().trim()
  }
  const branch = 'confinement-work'
  const worktree = join(repo, 'trees', branch)
  mkdirSync(dirname(worktree), { recursive: true })
  git(repo, 'worktree', 'add', '-b', branch, worktree, 'main')
  writeFileSync(join(worktree, 'change.txt'), 'change\n')
  git(worktree, 'add', 'change.txt'); git(worktree, 'commit', '-m', 'change')
  const tip = git(worktree, 'rev-parse', 'HEAD')
  const tree = git(worktree, 'rev-parse', 'HEAD^{tree}')
  const project = `confinement-${randomUUID()}`
  upsertProject({ name: project, path: repo, settings: { trunk: 'main', gate: 'true' } })
  const id = addRun({ agent: 'codex', job: 'implement', status: 'failed', session: 'orch-test-session', repo: project, inputTree: tree, headCommit: tip })
  db().query('UPDATE run SET worktree=?,branch=?,failure_kind=?,error=?,pre_confinement=?,vendor_session=? WHERE id=?')
    .run(worktree, branch, kind, 'confinement block', JSON.stringify({ status: 'ok', failureKind: null, error: null }), 'confinement-test-session', id)
  const audit = () => JSON.parse((db().query("SELECT reason FROM run_mutation_audit WHERE root_id=? AND action='reclassify' ORDER BY rowid DESC").get(id) as { reason: string }).reason) as Record<string, any>
  const logs: string[] = []
  const clear = (addressed = id, suppliedTip: string | null = null) => clearConfinement(addressed, { writer: 'operator', note: 'known edit', tip: suppliedTip }, { log: (...values) => logs.push(values.join(' ')) })
  return { repo, worktree, branch, tip, tree, id, git, audit, logs, clear }
}

describe('confinement ruling', () => {
  test('confinement refusals execute the working clear remedy for every kind and chain shape', () => {
    for (const kind of ['escaped', 'confinement_unverified'] as const) {
      const f = fixture(kind)
      try {
        expect(() => refuseEscapedChain(f.id)).toThrow(`orch confinement clear ${f.id} --writer TEXT --note TEXT`)
        f.clear()
        expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(f.id)).toEqual({ failure_kind: null })
      } finally { rmSync(f.repo, { recursive: true, force: true }) }
    }
  })
  test('confinement clear restores an unchanged artifact and audits both tips and trees', () => {
    const f = fixture()
    try {
      f.clear()
      expect(db().query('SELECT status,failure_kind,error FROM run WHERE id=?').get(f.id)).toEqual({ status: 'ok', failure_kind: null, error: null })
      expect(f.audit()).toMatchObject({ writer: 'operator', note: 'known edit', recordedTip: f.tip, currentTip: f.tip, recordedTree: f.tree, currentTree: f.tree, divergence: false, cleared: true })
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  })

  test('confinement clear refuses a zero-row guarded update without a success audit', () => {
    const f = fixture('confinement_unverified')
    try {
      db().exec(`CREATE TRIGGER ignore_confinement_clear BEFORE UPDATE OF status ON run WHEN OLD.id=${f.id} AND OLD.failure_kind='confinement_unverified' BEGIN SELECT RAISE(IGNORE); END`)
      expect(() => f.clear()).toThrow(`run ${f.id}'s confinement classification changed before it could be cleared`)
      expect(db().query('SELECT status,failure_kind,error FROM run WHERE id=?').get(f.id)).toEqual({ status: 'failed', failure_kind: 'confinement_unverified', error: 'confinement block' })
      expect(db().query("SELECT COUNT(*) n FROM run_mutation_audit WHERE root_id=? AND action='reclassify' AND json_extract(reason,'$.cleared')=1").get(f.id)).toEqual({ n: 0 })
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  })

  test('confinement clear records a missing worktree block', () => {
    const f = fixture()
    try {
      f.git(f.repo, 'worktree', 'remove', f.worktree)
      f.clear()
      const pre = JSON.parse((db().query('SELECT pre_confinement FROM run WHERE id=?').get(f.id) as { pre_confinement: string }).pre_confinement)
      expect(pre.landingBlock).toMatchObject({ worktree: f.worktree, command: `git worktree add ${f.worktree} ${f.branch}` })
      expect(f.logs.join('\n')).toContain(`recorded worktree ${f.worktree} is missing`)
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  })

  test('confinement clear refuses a moved tip without --tip and audits the divergence', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.worktree, 'later.txt'), 'later\n'); f.git(f.worktree, 'add', 'later.txt'); f.git(f.worktree, 'commit', '-m', 'later')
      const currentTip = f.git(f.worktree, 'rev-parse', 'HEAD')
      expect(() => f.clear()).toThrow(`pass --tip ${currentTip}`)
      expect(f.audit()).toMatchObject({ recordedTip: f.tip, currentTip, divergence: true, suppliedTip: null, cleared: false })
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  })

  test('confinement clear uses a snapshotted trip tip and does not need --tip', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.worktree, 'later.txt'), 'later\n'); f.git(f.worktree, 'add', 'later.txt'); f.git(f.worktree, 'commit', '-m', 'later')
      const currentTip = f.git(f.worktree, 'rev-parse', 'HEAD')
      db().query('UPDATE run SET confinement=? WHERE id=?').run(JSON.stringify({ classification: 'overlapping', attribution: 'unattributed', tripTip: currentTip, chainRoot: f.tip }), f.id)
      f.clear()
      expect(db().query('SELECT status,failure_kind FROM run WHERE id=?').get(f.id)).toEqual({ status: 'ok', failure_kind: null })
      expect(f.audit()).toMatchObject({ currentTip, divergence: true, suppliedTip: null, cleared: true, tripTip: currentTip, chainRoot: f.tip })
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  })

  test('confinement clear accepts an acknowledged moved tip and audits it', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.worktree, 'later.txt'), 'later\n'); f.git(f.worktree, 'add', 'later.txt'); f.git(f.worktree, 'commit', '-m', 'later')
      const currentTip = f.git(f.worktree, 'rev-parse', 'HEAD')
      const currentTree = f.git(f.worktree, 'rev-parse', 'HEAD^{tree}')
      f.clear(f.id, currentTip)
      expect(f.audit()).toMatchObject({ recordedTip: f.tip, currentTip, recordedTree: f.tree, currentTree, divergence: true, suppliedTip: currentTip, cleared: true })
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  })
})
