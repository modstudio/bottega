import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixtures/git.ts'
import { addRun, score } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { runSweep } from '../test/fake-sweep.ts'
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'

const repos: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-reclaim-'))
  repos.push(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'orch-test@example.invalid')
  git(repo, 'config', 'user.name', 'Orch Test')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, 'commit', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  const project = `reclaim-${repo.split('/').pop()}`
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  score(run, 'full', 'right', 'faithful')
  const branch = `technical/DEV-391-orch-${run}`
  const tree = join(repo, '.claude', 'worktrees', `orch-${run}`)
  git(repo, 'worktree', 'add', '-b', branch, tree, 'main')
  db().query(
    `UPDATE run SET worktree=?, cwd=?, branch=?, minted_branch=?, base_commit=?,
                    worktree_source='git' WHERE id=?`,
  ).run(tree, tree, branch, branch, base, run)
  return { repo, project, run, branch, tree }
}

async function orch(_cwd: string, args: string[], env: Record<string, string> = {}) {
  if (args[0] === 'sweep') return runSweep(env, ...args)
  const prior = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    const dryRun = args.includes('--dry-run')
    const result = args[1] === 'worktree'
      ? reclaimWorktree(args[2]!, { dryRun })
      : reclaimBranch(args[2]!, { dryRun })
    return { code: result.ok ? 0 : 1, out: result.ok ? result.action : '', err: result.ok ? '' : result.action }
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function emptyProcessInventory(repo: string): Record<string, string> {
  const commands = join(repo, 'test-bin')
  mkdirSync(commands, { recursive: true })
  const ps = join(commands, 'ps')
  writeFileSync(ps, '#!/bin/sh\nexit 0\n')
  chmodSync(ps, 0o755)
  return { PATH: `${commands}:${process.env.PATH ?? ''}` }
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})
describe('proof-bearing reclaim verbs', () => {
  test('sweep project scope selects one registered project and refuses an unknown name', async () => {
    const selected = fixture()
    const other = fixture()
    // Scope follows the registered path, not a stale or corrupt run.repo label.
    db().query('UPDATE run SET repo=? WHERE id=?').run(selected.project, other.run)
    const scoped = await orch(selected.repo, ['sweep', '--project', selected.project, '--dry-run'],
      emptyProcessInventory(selected.repo))
    expect(scoped.code, scoped.err).toBe(0)
    expect(scoped.out).toContain(`would reclaim ${selected.run}  ${selected.tree}`)
    expect(scoped.out).not.toContain(other.tree)
    expect(existsSync(selected.tree)).toBe(true)
    expect(existsSync(other.tree)).toBe(true)

    const unknown = await orch(selected.repo, ['sweep', '--project', 'missing-project', '--dry-run'])
    expect(unknown.code).not.toBe(0)
    expect(unknown.err).toContain('unknown project missing-project')
  })

  test('worktree reclaim refuses every claim from another terminal conversation', async () => {
    const f = fixture()
    const sibling = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: f.project })
    score(sibling, 'full', 'right', 'faithful')
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='git' WHERE id=?`,
    ).run(`${f.tree}/`, f.tree, f.branch, f.branch, git(f.repo, 'rev-parse', 'main'), sibling)

    const before = db().query('SELECT id, worktree FROM run WHERE id IN (?, ?) ORDER BY id')
      .all(f.run, sibling)
    const preview = await orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(preview.code).not.toBe(0)
    expect(preview.err).toContain(
      `refused; worktree ${realpathSync(f.tree)} is still claimed by other conversation(s): run ${sibling} (ok)`,
    )

    const refused = await orch(f.repo, ['reclaim', 'worktree', f.tree])
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain(`still claimed by other conversation(s): run ${sibling} (ok)`)
    expect(existsSync(f.tree)).toBe(true)
    expect(db().query('SELECT id, worktree FROM run WHERE id IN (?, ?) ORDER BY id')
      .all(f.run, sibling)).toEqual(before)
  })

  test('kept-tip proof belongs only to a run that minted the subject branch', async () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'unique.txt'), 'unique\n')
    git(f.tree, 'add', 'unique.txt')
    git(f.tree, 'commit', '-m', 'unique')
    const tip = git(f.tree, 'rev-parse', 'HEAD')
    git(f.repo, 'worktree', 'remove', '--force', f.tree)

    const unrelated = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: f.project })
    score(unrelated, 'full', 'right', 'faithful')
    db().query(
      'UPDATE run SET branch=?, minted_branch=?, branch_kept=?, branch_kept_tip=? WHERE id=?',
    ).run(f.branch, 'technical/DEV-391-different', f.branch, tip, unrelated)

    const result = await orch(f.repo, ['reclaim', 'branch', `${f.project}:${f.branch}`])
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe(f.branch)
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(tip)
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`commits unreachable from landing branch main: ${tip}`)
  })

  test('branch reclaim refuses registered landing and production branches by name', async () => {
    const f = fixture()
    upsertProject({
      name: f.project, path: f.repo,
      settings: { trunk: 'main', productionBranch: 'production' },
    })
    git(f.repo, 'branch', 'production', 'main')
    git(f.repo, 'switch', '--detach')

    const landing = await orch(f.repo, ['reclaim', 'branch', `${f.project}:main`, '--dry-run'])
    expect(landing.code).not.toBe(0)
    expect(landing.err).toContain(`refused; branch ${f.project}:main is the registered landing branch`)

    const production = await orch(f.repo, ['reclaim', 'branch', `${f.project}:production`, '--dry-run'])
    expect(production.code).not.toBe(0)
    expect(production.err).toContain(`refused; branch ${f.project}:production is the registered production branch`)
  })

  test('branch reclaim refuses when checked-out worktrees cannot be inspected', async () => {
    const f = fixture()
    const bin = join(f.repo, 'failing-git')
    mkdirSync(bin)
    const realGit = Bun.spawnSync(['which', 'git']).stdout.toString().trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1 $2" = "worktree list" ]; then echo inspection-denied >&2; exit 128; fi\nexec "${realGit}" "$@"\n`)
    chmodSync(join(bin, 'git'), 0o755)

    const result = await orch(
      f.repo,
      ['reclaim', 'branch', `${f.project}:${f.branch}`, '--dry-run'],
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    )
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('refused; checked-out worktrees could not be inspected: inspection-denied')
  })

  test('worktree reclaim refuses a recorded directory that is not a registered git worktree', async () => {
    const f = fixture()
    git(f.repo, 'worktree', 'remove', '--force', f.tree)
    mkdirSync(f.tree, { recursive: true })

    const result = await orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('refused; worktree safety could not be proved: not a registered git worktree')
    expect(existsSync(f.tree)).toBe(true)
  })

  test('worktree reclaim refuses the registered checkout by path', async () => {
    const main = fixture()
    git(main.repo, 'worktree', 'remove', '--force', main.tree)
    const moved = `${main.repo}.reclaimed`
    repos.push(moved)
    upsertProject({
      name: main.project,
      path: main.repo,
      settings: {
        trunk: 'main',
        worktree: { remove: 'mv {path} {path}.reclaimed' },
      },
    })
    const registeredPath = realpathSync(main.repo)
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch='main', minted_branch=NULL,
                      worktree_source='recipe' WHERE id=?`,
    ).run(main.repo, main.repo, main.run)
    const registered = await orch(main.repo, ['reclaim', 'worktree', main.repo])
    expect(existsSync(main.repo)).toBe(true)
    expect(existsSync(moved)).toBe(false)
    expect(registered.code).not.toBe(0)
    expect(registered.err).toContain(`refused; worktree ${registeredPath} is the project's registered checkout`)
  })

  test('worktree reclaim refuses a path outside the project worktrees directory', async () => {
    const outside = fixture()
    const outsideTree = join(outside.repo, 'outside-worktree')
    git(outside.repo, 'worktree', 'move', outside.tree, outsideTree)
    db().query('UPDATE run SET worktree=?, cwd=? WHERE id=?').run(outsideTree, outsideTree, outside.run)
    const escaped = await orch(outside.repo, ['reclaim', 'worktree', outsideTree])
    expect(existsSync(outsideTree)).toBe(true)
    expect(escaped.code).not.toBe(0)
    expect(escaped.err).toContain('is not beneath project worktrees directory')
  })

  test('sweep routes remembered trees through the containment proof', async () => {
    const outside = fixture()
    const outsideTree = join(outside.repo, 'outside-sweep-worktree')
    git(outside.repo, 'worktree', 'move', outside.tree, outsideTree)
    db().query(
      "UPDATE run SET worktree=?, cwd=?, started_at=datetime('now', '-2 days') WHERE id=?",
    ).run(outsideTree, outsideTree, outside.run)
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const path of git(outsideTree, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
      utimesSync(join(outsideTree, path), old, old)
    }

    const swept = await orch(outside.repo, ['sweep'], emptyProcessInventory(outside.repo))
    expect(existsSync(outsideTree)).toBe(true)
    expect(swept.code).toBe(0)
    expect(swept.out).toContain('is not beneath project worktrees directory')
  })

  test('branch reclaim refuses live ownership and a branch no run minted', async () => {
    const live = fixture()
    git(live.repo, 'worktree', 'remove', '--force', live.tree)
    db().query("UPDATE run SET status='running', pid=? WHERE id=?").run(process.pid, live.run)
    const liveResult = await orch(live.repo, ['reclaim', 'branch', `${live.project}:${live.branch}`, '--dry-run'])
    expect(liveResult.code).not.toBe(0)
    expect(liveResult.err).toContain(`refused; run ${live.run} worker pid ${process.pid} is live`)
    expect(git(live.repo, 'branch', '--list', live.branch)).toBe(live.branch)

    const unowned = fixture()
    git(unowned.repo, 'worktree', 'remove', '--force', unowned.tree)
    const branch = 'technical/DEV-391-unowned'
    git(unowned.repo, 'branch', branch, 'main')
    const unownedResult = await orch(unowned.repo, ['reclaim', 'branch', `${unowned.project}:${branch}`, '--dry-run'])
    expect(unownedResult.code).not.toBe(0)
    expect(unownedResult.err).toContain(`refused; no run row records minted branch ${unowned.project}:${branch}`)
    expect(git(unowned.repo, 'branch', '--list', branch)).toBe(branch)
  })

  test('dry-run reclaim verbs create no lock or waiter state', async () => {
    const f = fixture()
    const common = git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const lockState = () => readdirSync(common).filter((name) => name.startsWith('orch-')).sort()
    const beforeWorktree = lockState()
    const worktree = await orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(worktree.code, worktree.err).toBe(0)
    expect(lockState()).toEqual(beforeWorktree)

    git(f.repo, 'worktree', 'remove', '--force', f.tree)
    const beforeBranch = lockState()
    const branch = await orch(f.repo, ['reclaim', 'branch', `${f.project}:${f.branch}`, '--dry-run'])
    expect(branch.code, branch.err).toBe(0)
    expect(lockState()).toEqual(beforeBranch)
  })

  test('worktree reclaim honours keep_tree', async () => {
    const f = fixture()
    db().query('UPDATE run SET keep_tree=1 WHERE id=?').run(f.run)

    const result = await orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`refused; run ${f.run} records keep_tree; its worktree is protected`)
    expect(existsSync(f.tree)).toBe(true)
  })
})
