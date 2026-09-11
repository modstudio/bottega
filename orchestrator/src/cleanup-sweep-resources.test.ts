import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addRun, db, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, score, upsertProject } from '../test/fixture.ts'
import { runSweep } from '../test/fake-sweep.ts'
describe('sweep only reclaims old orch-owned orphan worktrees', () => {
  const processInventoryBin = mkdtempSync(join(tmpdir(), 'orch-empty-process-inventory-'))
  writeFileSync(join(processInventoryBin, 'ps'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(processInventoryBin, 'ps'), 0o755)
  afterAll(() => rmSync(processInventoryBin, { recursive: true, force: true }))
  const orch = (...args: string[]) => runSweep({
    PATH: `${processInventoryBin}:${process.env.PATH ?? ''}`,
  }, ...args)
  const orchWithEnv = (env: Record<string, string>, ...args: string[]) => runSweep({
    ...env, PATH: `${processInventoryBin}:${env.PATH ?? process.env.PATH ?? ''}`,
  }, ...args)
  const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const gitWithEnv = (cwd: string, env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const ageHead = (repo: string, days: number) => {
    const date = new Date(Date.now() - days * 86_400_000).toISOString()
    gitWithEnv(
      repo, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      'commit', '--amend', '--no-edit', '--date', date,
    )
  }
  const ageWorktree = (tree: string, hours = 3) => {
    const old = new Date(Date.now() - hours * 60 * 60 * 1000)
    for (const name of git(tree, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
      utimesSync(join(tree, name), old, old)
    }
  }
  const scratchRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-sweep-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'orch-test@example.invalid')
    git(repo, 'config', 'user.name', 'Orch Test')
    writeFileSync(join(repo, 'kept.txt'), 'base\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'base')
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true })
    upsertProject({ name: `sweep-${repo.split('/').pop()}`, path: repo, settings: { trunk: 'main' } })
    return repo
  }

  test("a successful project remove command's warning is attributed", async () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const tree = join(repo, '.claude', 'worktrees', 'old-worker')
    try {
      ageHead(repo, 2)
      git(repo, 'worktree', 'add', '-b', 'old-worker', tree, 'main')
      writeFileSync(join(tree, '.orch-run'), `903\n${repo}\n`)
      appendFileSync(resolve(tree, git(tree, 'rev-parse', '--git-path', 'info/exclude')), '.orch-run\n')
      ageWorktree(tree)
      upsertProject({
        name, path: repo,
        settings: {
          trunk: 'main',
          worktree: {
            remove:
              "echo 'retained fixture resource' >&2; " +
              `${hermeticGitCommand} worktree remove --force {path}; ` +
              `${hermeticGitCommand} branch -D {branch}`,
          },
        },
      })

      const r = await orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${name} remove:`)
      expect(r.out).toContain('retained fixture resource')
      expect(r.out).toContain(`reclaimed orphan  ${tree}`)
      expect(existsSync(tree)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a project sweep refusal is attributed and makes sweep fail', async () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const sentinel = join(repo, 'project-resource')
    upsertProject({
      name, path: repo,
      settings: {
        trunk: 'main',
        worktree: { sweep: `printf retained > "${sentinel}"; echo 'database remains' >&2; exit 7` },
      },
    })
    try {
      const r = await orch('sweep')
      expect(r.code).not.toBe(0)
      expect(readFileSync(sentinel, 'utf8')).toBe('retained')
      expect(r.out).toContain(`${name} sweep:`)
      expect(r.out).toContain('database remains')
      expect(r.err).toContain(`project ${name} sweep failed with exit status 7`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('sweep does not classify infrastructure for a running run as orphaned', async () => {
    const project = `live-resource-${randomUUID()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const docker = fakeDocker([`orch-${id}-booting`], [])
    try {
      const r = await orchWithEnv(docker.env, 'sweep')
      expect(r.code).toBe(0)
      expect(r.err).not.toContain(`orch-${id}-booting`)
      expect(r.err).not.toContain('leaked Docker resources')

    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep exits non-zero and keeps the pointer when project removal is refused', async () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    score(id, 'full', 'right')
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')
    upsertProject({
      name: project, path: repo,
      settings: { trunk: 'main', worktree: { remove: "echo 'protected work' >&2; exit 7" } },
    })
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(tree, `orch/${id}`, `orch/${id}`, git(repo, 'rev-parse', 'main'), id)
    try {
      ageWorktree(tree)
      const r = await orch('sweep', '--force')
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(`could not reclaim ${id}`)
      expect(r.err).toContain('protected work')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('sweep reports unavailable Docker inventory after releasing the tree', async () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: project,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    score(id, 'full', 'right')
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')
    upsertProject({
      name: project, path: repo,
      settings: {
        trunk: 'main',
        worktree: {
          remove: `${hermeticGitCommand} worktree remove --force {path}; ` +
            `${hermeticGitCommand} branch -D {branch}`,
        },
      },
    })
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(tree, `orch/${id}`, `orch/${id}`, git(repo, 'rev-parse', 'main'), id)
    const docker = fakeDockerCommand("echo 'stub inventory failure' >&2; exit 127")
    try {
      ageWorktree(tree)
      const r = await orchWithEnv(docker.env, 'sweep', '--force')
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('inventory unavailable: 1')
      expect(r.err).toContain('stub inventory failure')
      expect(r.err).not.toContain('leaked Docker resources: 0')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep reports resources left by a project remove in its summary', async () => {
    const repo = scratchRepo()
    const project = `sweep-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    score(id, 'full', 'right')
    const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
    git(repo, 'worktree', 'add', '-b', `orch/${id}`, tree, 'main')
    upsertProject({
      name: project, path: repo,
      settings: {
        trunk: 'main',
        worktree: {
          remove: `${hermeticGitCommand} worktree remove --force {path}; ` +
            `${hermeticGitCommand} branch -D {branch}`,
        },
      },
    })
    db().query(
      `UPDATE run SET worktree=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(tree, `orch/${id}`, `orch/${id}`, git(repo, 'rev-parse', 'main'), id)
    const docker = fakeDocker([], [`orch-${id}_${project}-pgdata`])
    try {
      ageWorktree(tree)
      const r = await orchWithEnv(docker.env, 'sweep', '--force')
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('leaked Docker resources: 1')
      expect(r.err).toContain(`volume orch-${id}_${project}-pgdata leaked by project ${project}`)
      expect(r.out).toContain('reclaimed 0, kept 1')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: tree })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep dry-run retains containers and volumes without a recorded worktree', async () => {
    const project = `dry-run-leak-${randomUUID()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const docker = fakeDocker(
      [`orch-${id}-postgres-1`],
      [`orch-${id}_${project}-pgdata`],
    )
    try {
      const r = await orchWithEnv(docker.env, 'sweep', '--dry-run')
      expect(r.code).toBe(0)
      expect(r.err).toContain('would report retained worktree Docker resources: 2')
      expect(r.err).toContain(
        `container orch-${id}-postgres-1 re-served or retained by project ${project} (run ${id}); removal could not be ascertained: no recorded worktree`,
      )
      expect(r.err).toContain(
        `volume orch-${id}_${project}-pgdata re-served or retained by project ${project} (run ${id}); removal could not be ascertained: no recorded worktree`,
      )
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep and doctor report terminal resources in a retained tree without removal commands', async () => {
    const project = `retained-resource-${randomUUID()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const tree = mkdtempSync(join(tmpdir(), `orch-${id}-retained-`))
    expect(Bun.spawnSync(['git', 'init', '-q', tree]).exitCode).toBe(0)
    db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, id)
    const noTree = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project,
      parent: noTree, turn: 2 })
    const goneTree = addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(join(tree, 'gone'), goneTree)
    const sharedTree = mkdtempSync(join(tmpdir(), `orch-${id}-shared-`))
    expect(Bun.spawnSync(['git', 'init', '-q', sharedTree]).exitCode).toBe(0)
    const terminalSharer = addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project })
    const liveSharer = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(sharedTree, terminalSharer)
    db().query('UPDATE run SET worktree=? WHERE id=?').run(`${sharedTree}/`, liveSharer)
    const docker = fakeDocker([
      `orch-${id}-web`, `orch-${noTree}-web`, `orch-${goneTree}-web`, `orch-${terminalSharer}-web`,
    ], [`orch-${id}_${project}-pgdata`])
    try {
      const sweep = await orchWithEnv(docker.env, 'sweep', '--dry-run')
      expect(sweep.code).toBe(0)
      expect(sweep.err).toContain('retained worktree Docker resources: 5')
      expect(sweep.err).toContain('removal could not be ascertained: no recorded worktree')
      expect(sweep.err).toContain('removal could not be ascertained: unresolvable repository root')
      expect(sweep.err).toContain('removal could not be ascertained: live sharer present')
      expect(sweep.err).toContain('no removal suggested')
      expect(sweep.err).not.toContain('docker rm')

    } finally {
      rmSync(tree, { recursive: true, force: true })
      rmSync(sharedTree, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('an aged no-verdict void with an absent tree is released without an evidence guard', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const id = addRun({ agent: 'codex', job: 'understand', status: 'ok', startedAt: old })
    db().query("UPDATE run SET worktree=?, evidence_excluded=? WHERE id=?")
      .run(`/tmp/dev364-void-${id}`, 'voided with orch score --void', id)

    const r = await orch('sweep', '--dry-run')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`would reclaim ${id}  /tmp/dev364-void-${id}`)
    expect(r.out).toContain('would reclaim 1, kept 0')
    expect(r.out).not.toContain('unscored — its diff is the evidence')
  })

  test('terminal sharers do not block sweep regardless of scoring or void state', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const tree = '/tmp/dev364-shared-tree'
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', startedAt: old })
    score(target, 'full', 'right')
    const voided = addRun({ agent: 'codex', job: 'understand', status: 'ok', startedAt: old })
    const unscored = addRun({ agent: 'codex', job: 'implement', status: 'failed', startedAt: old })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, target)
    db().query("UPDATE run SET worktree=?, evidence_excluded=? WHERE id=?")
      .run(tree, 'voided with orch score --void', voided)
    db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, unscored)

    const released = await orch('sweep', '--dry-run')
    expect(released.code).toBe(0)
    expect(released.out).toContain(`would reclaim ${target}  ${tree}`)
    expect(released.out).toContain(`would reclaim ${voided}  ${tree}`)
    expect(released.out).toContain(`would reclaim ${unscored}  ${tree}`)
    expect(released.out).not.toContain('unscored')
    expect(released.out).not.toContain('shared with')
  })

  test('more than ten kept rows are summarised by reason; --dry-run lists every row', async () => {
    const held: number[] = []
    for (let i = 0; i < 11; i++) {
      const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
      db().query('UPDATE run SET worktree=?, keep_tree=1 WHERE id=?').run(`/tmp/dev148-held-${i}`, id)
      held.push(id)
    }

    const summarised = await orch('sweep')
    expect(summarised.code).toBe(0)
    expect(summarised.out).toContain('reclaimed 0, kept 11')
    expect(summarised.out).toContain('11  held by explicit --keep-tree; clear with orch discard <run-id>')
    expect(summarised.out).toContain('orch sweep --dry-run lists every kept row')
    for (const id of held) expect(summarised.out).not.toContain(`${id}  held:`)

    const listed = await orch('sweep', '--dry-run')
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('would reclaim 0, kept 11')
    expect(listed.out).toContain('11  held by explicit --keep-tree; clear with orch discard <run-id>')
    expect(listed.out).not.toContain('lists every kept row')
    for (const id of held) expect(listed.out).toContain(`${id}  held:`)
  })

  test('a project sweep longer than eight lines says how many were omitted', async () => {
    const repo = scratchRepo()
    const name = `sweep-${repo.split('/').pop()}`
    const lines = Array.from({ length: 10 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
    upsertProject({
      name, path: repo,
      settings: {
        trunk: 'main',
        worktree: { sweep: `printf '%s\\n' ${lines.join(' ')}` },
      },
    })
    try {
      const r = await orch('sweep')
      expect(r.code).toBe(0)
      expect(r.out).toContain(`${name} sweep:`)
      expect(r.out).toContain('L03')
      expect(r.out).toContain('L10')
      expect(r.out).not.toContain('L01')
      expect(r.out).not.toContain('L02')
      expect(r.out).toContain('(2 earlier lines omitted)')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
