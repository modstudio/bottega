import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, compoundCreate, createWithTool, createWorktree, db, declaredCreate, fakeDocker, hermeticGitCommand, hermeticGitEnv, nowIso, prepareSharedRefGuard, processStartTime, projectLockDir, reclaimStaleProjectLock, resolveBase, runJob, staleProjectLockHolder, upsertProject, withWorktreeCreateLock } from '../test/fixture.ts'

import { worktreeDescribeFixture } from '../test/fixture.ts'

describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo } = worktreeDescribeFixture()
test('project lock state resolves under the shared git common directory regardless of environment', () => {
  const { repo } = scratchRepo()
  const priorXdg = process.env.XDG_RUNTIME_DIR
  try {
    const xdg = mkdtempSync(join(tmpdir(), 'orch-xdg-'))
    const expected = realpathSync(join(repo, '.git'))
    expect(projectLockDir(repo)).toBe(join(expected, 'orch', 'locks'))
    process.env.XDG_RUNTIME_DIR = xdg
    expect(projectLockDir(repo)).toBe(join(expected, 'orch', 'locks'))
    const linked=join(repo,'linked-runtime-key');git(repo,'worktree','add','-b','runtime-key',linked,'HEAD')
    expect(projectLockDir(linked)).toBe(projectLockDir(repo))
  } finally {
    if (priorXdg === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = priorXdg
    rmSync(repo, { recursive: true, force: true })
  }
})

test('two environment bases contend on the shared checkout lock', async () => {
  const { repo } = scratchRepo()
  const linked = join(repo, 'linked-lock-contender')
  git(repo, 'worktree', 'add', '-b', 'lock-contender', linked, 'HEAD')
  const ready = join(repo, 'two-base-ready')
  const release = join(repo, 'two-base-release')
  const xdgOne = mkdtempSync(join(tmpdir(), 'orch-xdg-one-'))
  const xdgTwo = mkdtempSync(join(tmpdir(), 'orch-xdg-two-'))
  const child = Bun.spawn([process.execPath, '-e',
    `const{existsSync,writeFileSync}=await import('node:fs');const{withProjectLock}=await import(process.argv[1]);withProjectLock(process.argv[2],'landing',{session:'one',what:'base-one'},()=>{writeFileSync(process.argv[3],'');while(!existsSync(process.argv[4]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)},5000,true)`,
    new URL('./worktree.ts', import.meta.url).href, repo, ready, release,
  ], { env: { ...hermeticGitEnv(), XDG_RUNTIME_DIR: xdgOne }, stdout: 'pipe', stderr: 'pipe' })
  try {
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5)
    expect(existsSync(ready)).toBe(true)
    const contender = Bun.spawnSync([process.execPath, '-e',
      `const{withProjectLock}=await import(process.argv[1]);withProjectLock(process.argv[2],'landing',{session:'two',what:'base-two'},()=>{},30,true)`,
      new URL('./worktree.ts', import.meta.url).href, linked,
    ], { env: { ...hermeticGitEnv(), XDG_RUNTIME_DIR: xdgTwo }, stdout: 'pipe', stderr: 'pipe' })
    expect(contender.exitCode).not.toBe(0)
    expect(contender.stderr.toString()).toContain('timed out')
  } finally {
    writeFileSync(release, '')
    await child.exited
    rmSync(repo, { recursive: true, force: true })
    rmSync(xdgOne, { recursive: true, force: true })
    rmSync(xdgTwo, { recursive: true, force: true })
  }
})
test('a resumed turn waits for cleanup and refuses a worktree removed under the lifecycle lock', async () => {
    const { repo } = scratchRepo()
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const tree = createWorktree(repo, root)
    const promptPath = join(repo, 'resume-root.prompt.txt')
    const ready = join(repo, 'cleanup-ready')
    const cleanup = join(repo, 'paused-cleanup.ts')
    writeFileSync(promptPath, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=?, cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(promptPath, tree.path, tree.path, tree.branch, tree.base, root)
    writeFileSync(cleanup,
      `import { writeFileSync } from 'node:fs'\n` +
      `import { withProjectLock } from ${JSON.stringify(new URL('worktree.ts', import.meta.url).href)}\n` +
      `withProjectLock(process.argv[2], 'create', { session: null, what: 'fixture cleanup' }, () => {\n` +
      `  writeFileSync(process.argv[5], 'ready')\n` +
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)\n` +
      `  const removed = Bun.spawnSync(['git', 'worktree', 'remove', '--force', process.argv[3]], { cwd: process.argv[2], stdout: 'pipe', stderr: 'pipe' })\n` +
      `  if (removed.exitCode !== 0) throw new Error(removed.stderr.toString())\n` +
      `  Bun.spawnSync(['git', 'branch', '-D', process.argv[4]], { cwd: process.argv[2], stdout: 'pipe', stderr: 'pipe' })\n` +
      `})\n`)
    const holder = Bun.spawn(
      [process.execPath, cleanup, repo, tree.path, tree.branch, ready],
      { env: { ...hermeticGitEnv(), ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' },
    )
    while (!existsSync(ready)) await Bun.sleep(10)
    let failure: Error | null = null
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    try {
      await runJob({
        job: 'implement', prompt: 'continue', cwd: tree.path, noFailover: true,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
    } catch (error) {
      failure = error as Error
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    try {
      expect(await holder.exited).toBe(0)
      expect(failure?.message).toContain(`resumed worktree ${tree.path} no longer exists`)
      const child = db().query(
        'SELECT status, worktree, error FROM run WHERE parent_run_id=? ORDER BY id DESC LIMIT 1',
      ).get(root) as { status: string; worktree: string | null; error: string | null }
      expect(child.status).toBe('failed')
      expect(child.worktree).toBeNull()
      expect(child.error).toContain(`resumed worktree ${tree.path} no longer exists`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('separate processes serialize complete creation for the same project', async () => {
    const { repo } = scratchRepo()
    const overlap = join(repo, '.git', 'creation-overlap')
    const module = new URL('worktree.ts', import.meta.url).href
    const child = `
      const { createWithTool } = await import(process.argv[1])
      createWithTool({ create: JSON.parse(process.argv[4]), branch: 'orch/{id}' }, process.argv[2], Number(process.argv[3]))
    `
    const create = compoundCreate(
      `if ! mkdir "${overlap}"; then echo 'creations overlapped' >&2; exit 19; fi; ` +
      `trap 'rmdir "${overlap}"' EXIT; sleep 0.15; ` +
      `${hermeticGitCommand} worktree add -b {branch} "${repo}/.claude/worktrees/{name}" HEAD ` +
      `>/dev/null && echo "${repo}/.claude/worktrees/{name}"`)
    try {
      const children = [910, 911, 912, 913].map((id) => Bun.spawn(
        [process.execPath, '-e', child, module, repo, String(id), JSON.stringify(create)],
        { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
      ))
      const exits = await Promise.all(children.map((p) => p.exited))
      expect(exits).toEqual([0, 0, 0, 0])
      for (const id of [910, 911, 912, 913]) {
        const path = join(repo, '.claude', 'worktrees', `orch-${id}`)
        expect(git(path, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')
        expect(git(path, 'diff', '--exit-code', 'HEAD', '--')).toBe('')
        expect(git(path, 'diff', '--cached', '--exit-code', 'HEAD', '--')).toBe('')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a creation lock held by flock waits and names its holder on timeout', async () => {
    const { repo } = scratchRepo()
    const ready = join(repo, 'lock-ready')
    const release = join(repo, 'lock-release')
    const child = Bun.spawn([process.execPath, '-e',
      `const{existsSync,writeFileSync}=await import('node:fs');const{withWorktreeCreateLock}=await import(process.argv[1]);withWorktreeCreateLock(process.argv[2],()=>{writeFileSync(process.argv[3],'');while(!existsSync(process.argv[4]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)},20000)`,
      new URL('./worktree.ts', import.meta.url).href, repo, ready, release,
    ], { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts++) await Bun.sleep(5)
      expect(() => withWorktreeCreateLock(repo, () => undefined, 20)).toThrow(
        new RegExp(
          `timed out after 0\\.02s waiting for this project's worktree creation lock ` +
          `\\(holder session unknown, pid ${child.pid}, worktree creation, held for \\d+s\\)`,
        ),
      )
    } finally {
      writeFileSync(release, '')
      child.kill()
      await child.exited
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('legacy checkout lock and waiter directories are neither adopted nor removed', () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-create.lock')
    const waiters = join(repo, 'orch-create.waiters')
    try {
      mkdirSync(lock)
      mkdirSync(waiters)
      expect(withWorktreeCreateLock(repo, () => 'created', 20)).toBe('created')
      expect(existsSync(lock)).toBe(true)
      expect(existsSync(waiters)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an uncontended creation lock still runs the critical section', () => {
    const { repo } = scratchRepo()
    try {
      expect(withWorktreeCreateLock(repo, () => 'created')).toBe('created')
      expect(existsSync(join(repo, '.git', 'orch-create.lock'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a null recorded start time falls back to pid liveness alone', () => {
    const participant = {
      pid: process.pid, startTime: null, incarnation: 'legacy', session: 'legacy',
      what: 'landing', since: new Date(0).toISOString(),
    }
    expect(staleProjectLockHolder(participant)).toBeNull()
    expect(staleProjectLockHolder({ ...participant, pid: 2_147_483_647 }))
      .toBe('dead holder pid 2147483647')
  })

  test('malformed process identity is unknown, never stale', () => {
    const original = Bun.spawnSync
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[], options?: any) =>
      cmd[0] === 'ps'
        ? { exitCode: 0, stdout: Buffer.from('garbage\n'), stderr: Buffer.from(''), success: true }
        : original(cmd, options)) as typeof Bun.spawnSync)
    try {
      expect(processStartTime(process.pid)).toBeNull()
      expect(staleProjectLockHolder({
        pid: process.pid, startTime: 'Sat Sep  6 12:34:56 2026', incarnation: 'a',
        session: 's', what: 'landing', since: new Date(0).toISOString(),
      })).toBeNull()
    } finally {
      spawn.mockRestore()
    }
  })

  test('reclaim refuses to remove a live replacement after classifying a stale owner', () => {
    const { repo } = scratchRepo()
    const lock = join(repo, '.git', 'orch-landing.lock')
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner'), `${JSON.stringify({
        pid: process.pid, startTime: processStartTime(process.pid), incarnation: 'live-b',
        session: 'live', what: 'replacement', since: new Date().toISOString(),
      })}\n`)
      expect(reclaimStaleProjectLock(repo, 'landing')).toBeNull()
      expect(existsSync(lock)).toBe(true)
      expect(JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')).incarnation).toBe('live-b')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a tree whose disk contents disagree with HEAD is never returned', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-914')
    try {
      expect(() => createWithTool({
        branch: 'orch/{id}',
        create: compoundCreate(
          `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
          `printf 'not HEAD\\n' > "${path}/kept.txt" && ` +
          `printf 'from another tree\\n' > "${path}/contamination.txt" && echo "${path}"`),
      }, repo, 914)).toThrow(/worktree verification failed:[\s\S]*kept\.txt[\s\S]*contamination\.txt/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unreadable worktree index is a verification failure, not a clean tree', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'orch-915')
    try {
      expect(() => createWithTool({
        branch: 'orch/{id}',
        create: compoundCreate(
          `${hermeticGitCommand} worktree add -b {branch} "${path}" HEAD >/dev/null && ` +
          `printf broken > "$(${hermeticGitCommand} -C "${path}" rev-parse --git-path index)" && echo "${path}"`),
      }, repo, 915)).toThrow(/worktree verification failed: could not compare[\s\S]*index/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a successful tool postcondition failure names its branch and remove command', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      expect(() => createWithTool(
        {
          branch: 'technical/{key}-orch-{id}',
          create: declaredCreate('echo', [join(repo, 'missing-tree')]),
          remove: 'scripts/worktree remove {branch}',
        },
        process.cwd(), 735, undefined, 'STO-993',
      )).toThrow("scripts/worktree remove 'technical/STO-993-orch-735'")
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches a tool whose template asks for it', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    const custom = join(repo, 'elsewhere', 'based-746')
    try {
      process.chdir(tree)
      const expected = resolveBase(process.cwd(), 'main')
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" {base} >/dev/null && ` +
            `echo "${custom}"`),
          remove: 'git worktree remove {path}',
        },
        process.cwd(), 746, undefined, undefined, 'main',
      )
      expect(w.base).toBe(expected)
      expect(git(custom, 'rev-parse', 'HEAD')).toBe(expected)
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a command tool records the base its worktree actually uses', () => {
    const { repo, tree } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'self-based-746')
    try {
      git(repo, 'branch', 'tool-floor', 'main')
      writeFileSync(join(repo, 'later.txt'), 'later\n')
      git(repo, 'add', 'later.txt')
      git(repo, 'commit', '-m', 'later')
      const expected = resolveBase(repo, 'tool-floor')

      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add -b {branch} "${custom}" tool-floor ` +
            `>/dev/null && echo "${custom}"`),
          remove: 'git worktree remove {path}',
        },
        tree, 746,
      )

      expect(w.base).toBe(expected)
      expect(w.base).not.toBe(resolveBase(repo, 'main'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base without {base} still cuts the key-named branch at that commit', () => {
    const { repo, tree } = scratchRepo()
    const custom = join(repo, 'elsewhere', 'no-slot-747')
    try {
      const expected = resolveBase(repo, 'main')
      const w = createWithTool(
        {
          create: compoundCreate(
            `${hermeticGitCommand} worktree add "${custom}" HEAD >/dev/null && echo "${custom}"`),
          branch: 'task/{id}',
          remove: 'git worktree remove {path}',
        },
        tree, 747, undefined, undefined, 'main',
      )
      expect(w.mintedBranch).toBe('task/747')
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(expected)
      expect(git(repo, 'rev-parse', 'refs/heads/task/747')).toBe(expected)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an explicit base reaches the recipe path and overrides its default', () => {
    const { repo, tree } = scratchRepo()
    try {
      git(repo, 'branch', 'requested-base', 'main')
      writeFileSync(join(repo, 'later.txt'), 'later\n')
      git(repo, 'add', 'later.txt')
      git(repo, 'commit', '-m', 'later')
      const expected = resolveBase(repo, 'requested-base')

      const w = createWithTool(
        { recipe: { baseRef: 'main' } }, tree, 748,
        undefined, undefined, 'requested-base',
      )

      expect(w.base).toBe(expected)
      expect(git(w.path, 'rev-parse', 'HEAD')).toBe(expected)
      expect(existsSync(join(w.path, 'later.txt'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('diff surfaces the recorded base commit', () => {
    const { repo } = scratchRepo()
    const foreignObjects = mkdtempSync(join(tmpdir(), 'orch-foreign-objects-'))
    const cliEnv = {
      ...process.env, GIT_OBJECT_DIRECTORY: foreignObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: foreignObjects,
      ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
    }
    const w = createWorktree(repo, 749, 'main')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(w.path, w.branch, w.base, id)
    writeFileSync(join(w.path, 'kept.txt'), 'changed\n')
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'diff', String(id)], {
        env: cliEnv,
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(`base: ${w.base}`)
      expect(p.stderr.toString()).toContain(`base:     ${w.base}`)
      const applyCheck = Bun.spawnSync(['git', 'apply', '--check', '-'], {
        cwd: repo, env: hermeticGitEnv(), stdin: p.stdout, stdout: 'pipe', stderr: 'pipe',
      })
      expect(applyCheck.exitCode).toBe(0)

      const quiet = Bun.spawnSync([process.execPath, CLI, 'diff', String(id), '--quiet'], {
        env: cliEnv,
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(quiet.exitCode).toBe(0)
      expect(quiet.stdout.toString()).toContain(`base: ${w.base}`)
      expect(quiet.stderr.toString()).not.toContain(`base:     ${w.base}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignObjects, { recursive: true, force: true })
    }
  })

  test('discarding a child cleans the root-owned worktree and every chain pointer', () => {
    const { repo, tree } = scratchRepo()
    const root = addRun({ agent: 'codex', job: 'implement', session: 'session-A' })
    const child = addRun({
      agent: 'codex', job: 'implement', parent: root, turn: 2, session: 'session-B',
    })
    appendFileSync(join(repo, '.git', 'info', 'exclude'), '.orch-run\n')
    writeFileSync(join(tree, '.orch-run'), `${root}\n${repo}\nsource: git\n`)
    const guard = prepareSharedRefGuard(tree, 'refs/heads/AB-2581')
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id IN (?,?)')
      .run(repo, tree, 'AB-2581', git(repo, 'rev-parse', 'main'), root, child)
    try {
      const p = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'discard', String(child), '--force',
      ], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'session-A' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree)).toBe(false)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(false)
      expect(existsSync(join(repo, '.git', 'orch-guards', String(child)))).toBe(false)
      expect(db().query('SELECT id, worktree FROM run WHERE id IN (?,?) ORDER BY id').all(root, child))
        .toEqual([{ id: root, worktree: null }, { id: child, worktree: null }])
      expect(db().query(
        'SELECT run_id, root_id, action, actor_session FROM run_mutation_audit',
      ).get()).toEqual({ run_id: child, root_id: root, action: 'discard', actor_session: 'session-A' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard preserves a chain worktree that is evidence for another unscored chain', () => {
    const { repo, tree } = scratchRepo()
    const root = addRun({ agent: 'codex', job: 'implement', session: 'session-A' })
    const child = addRun({
      agent: 'codex', job: 'implement', parent: root, turn: 2, session: 'session-B',
    })
    const unscored = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id IN (?,?,?)')
      .run(repo, tree, 'AB-2581', git(repo, 'rev-parse', 'main'), root, child, unscored)
    try {
      const p = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'discard', String(child), '--force',
      ], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'session-A' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(1)
      expect(p.stderr.toString()).toContain(`run ${unscored} is failed and unscored`)
      expect(existsSync(tree)).toBe(true)
      expect(db().query('SELECT COUNT(*) n FROM run WHERE worktree=?').get(tree)).toEqual({ n: 3 })
      expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a failed unscored run does not pin a branch whose patch is already on trunk', () => {
    const { repo, tree } = scratchRepo()
    writeFileSync(join(tree, 'landed.txt'), 'landed patch\n')
    git(tree, 'add', 'landed.txt')
    git(tree, 'commit', '-m', 'DEV-348 landed patch')
    writeFileSync(join(repo, 'other.txt'), 'unrelated trunk change\n')
    git(repo, 'add', 'other.txt')
    git(repo, 'commit', '-m', 'DEV-348 unrelated trunk')
    git(repo, 'cherry-pick', 'AB-2581')
    upsertProject({ name: 'landed-failed-pin', path: repo, settings: { trunk: 'main' } })
    const root = addRun({ agent: 'codex', job: 'implement', session: 'worktree-owner-session' })
    const failed = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    db().query('UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=? WHERE id=?')
      .run('landed-failed-pin', tree, tree, 'AB-2581', 'AB-2581', git(repo, 'rev-parse', 'main'), root)
    db().query('UPDATE run SET repo=?,cwd=?,branch=? WHERE id=?')
      .run('landed-failed-pin', repo, 'AB-2581', failed)
    try {
      const discarded = Bun.spawnSync([
        process.execPath, new URL('cli.ts', import.meta.url).pathname,
        'discard', String(root), '--force',
      ], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          CLAUDE_CODE_SESSION_ID: 'worktree-owner-session' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(discarded.exitCode, discarded.stderr.toString()).toBe(0)
      expect(existsSync(tree)).toBe(false)
      expect(Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/AB-2581'], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      }).exitCode).not.toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard uses a registered project remove template', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 880)
    const argvFile = join(repo, 'remove-argv.txt')
    const script = join(repo, 'fake-remove.sh')
    writeFileSync(script,
      `printf '%s\n' "$@" > "${argvFile}"\n` +
      "echo 'retained fixture resource' >&2\n" +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'remove-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
        tree.path, tree.branch,
      ])
      expect(p.stdout.toString()).toContain('remove-tool remove:')
      expect(p.stdout.toString()).toContain('retained fixture resource')
      expect(existsSync(tree.path)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard surfaces a registered project remove refusal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 881)
    upsertProject({
      name: 'refusing-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: "echo 'protected work' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('protected work')
      expect(p.stderr.toString()).toContain(
        "Inspect and resolve the protected work with the project's own tooling",
      )
      expect(p.stderr.toString()).toContain(
        "--force will not override a project tool's refusal unless the tree carries orch's " +
        '.orch-run ownership marker',
      )
      expect(p.stderr.toString()).not.toContain('Look before overriding')
      expect(existsSync(tree.path)).toBe(true)
      const row = db().query('SELECT worktree FROM run WHERE id=?').get(id) as
        { worktree: string | null }
      expect(row.worktree).toBe(tree.path)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard does not treat a no-verdict void as unjudged shared evidence', () => {
    const { repo } = scratchRepo()
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const voided = addRun({ agent: 'codex', job: 'understand', status: 'ok' })
    const tree = createWorktree(repo, target)
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, target)
    db().query("UPDATE run SET cwd=?, worktree=?, branch=?, evidence_excluded=? WHERE id=?")
      .run(repo, tree.path, tree.branch, 'voided with orch score --void', voided)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).not.toContain('and unscored')
      expect(existsSync(tree.path)).toBe(false)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard refuses to remove a worktree that still holds another unscored run evidence', () => {
    const { repo } = scratchRepo()
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    const tree = createWorktree(repo, target)
    const evidence = join(tree.path, 'uncommitted-evidence.txt')
    writeFileSync(evidence, 'review me\n')
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(`run ${owner} is failed and unscored`)
      expect(readFileSync(evidence, 'utf8')).toBe('review me\n')
      expect(db().query('SELECT id, worktree FROM run WHERE id IN (?,?) ORDER BY id')
        .all(target, owner)).toEqual([
          { id: target, worktree: tree.path },
          { id: owner, worktree: tree.path },
        ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  for (const cleanup of ['discard', 'sweep'] as const) {
    test(`${cleanup} reclaims one scored multi-turn conversation`, () => {
      const { repo } = scratchRepo()
      const project = `${cleanup}-conversation-${repo.split('/').pop()}`
      upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main' } })
      const startedAt = new Date(Date.now() - 86_400_000).toISOString()
      const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', startedAt, repo: project })
      const child = addRun({
        agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2, startedAt,
        repo: project,
      })
      const tree = createWorktree(repo, root)
      db().query(
        `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
         VALUES (?,'full','right','faithful',?)`,
      ).run(root, nowIso())
      for (const id of [root, child]) {
        db().query(
          `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?,
                          worktree_source='git' WHERE id=?`,
        ).run(tree.path, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
      }
      const docker = fakeDocker([], [])
      try {
        const CLI = new URL('cli.ts', import.meta.url).pathname
        const args = cleanup === 'discard'
          ? ['discard', String(root), '--force']
          : ['sweep', '--older-than', '0']
        const p = Bun.spawnSync([process.execPath, CLI, ...args], {
          env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(p.exitCode).toBe(0)
        expect(existsSync(tree.path)).toBe(false)
        expect(db().query('SELECT id, worktree FROM run WHERE id IN (?,?) ORDER BY id')
          .all(root, child)).toEqual([
          { id: root, worktree: null },
          { id: child, worktree: null },
        ])
      } finally {
        rmSync(repo, { recursive: true, force: true })
        rmSync(docker.dir, { recursive: true, force: true })
      }
    })
  }

  test('discard through a child reports Docker resources named for its conversation root', () => {
    const { repo } = scratchRepo()
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2 })
    const tree = createWorktree(repo, root)
    db().query(
      `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
       VALUES (?,'full','right','faithful',?)`,
    ).run(root, nowIso())
    for (const id of [root, child]) {
      db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
        .run(tree.path, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    }
    const container = `orch-${root}-postgres-1`
    const docker = fakeDocker([container], [])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(child), '--force'],
        {
          env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(container)
      expect(p.stderr.toString()).toContain(`run ${root}`)
      expect(db().query('SELECT id, worktree FROM run WHERE id IN (?,?) ORDER BY id')
        .all(root, child)).toEqual([
        { id: root, worktree: tree.path },
        { id: child, worktree: tree.path },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('a successful project tool deletes an unchanged disposable branch for an already-gone tree', () => {
    const { repo } = scratchRepo()
    const project = `branch-postcondition-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    const tree = createWorktree(repo, id)
    git(repo, 'worktree', 'remove', '--force', tree.path)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: 'true' } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    const docker = fakeDocker([], [])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id)).toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('a successful project tool retains and reports a uniquely-committed branch', () => {
    const { repo } = scratchRepo()
    const project = `unique-branch-postcondition-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    const tree = createWorktree(repo, id)
    writeFileSync(join(tree.path, 'unique.txt'), 'keep me\n')
    git(tree.path, 'add', 'unique.txt')
    git(tree.path, 'commit', '-m', 'unique work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    git(repo, 'worktree', 'remove', '--force', tree.path)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: 'true' } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    const docker = fakeDocker([], [])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(p.stdout.toString()).toContain(`kept branch ${tree.branch}`)
      expect(db().query('SELECT worktree, branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null, branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('a successful project tool refuses an unprotected branch moved during teardown', () => {
    const { repo } = scratchRepo()
    const project = `moved-branch-postcondition-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking', repo: project })
    const tree = createWorktree(repo, id)
    git(repo, 'worktree', 'remove', '--force', tree.path)
    git(repo, 'checkout', '-b', 'fixture-later-tip')
    writeFileSync(join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', 'later.txt')
    git(repo, 'commit', '-m', 'later tip')
    const later = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    const script = join(repo, 'move-branch.sh')
    writeFileSync(script, `git update-ref "refs/heads/$1" "${later}"\n`)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    const docker = fakeDocker([], [])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(`moved unprotected branch ${tree.branch}`)
      expect(p.stderr.toString()).toContain(later)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(later)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('sweep refuses a unique branch before the project teardown tool can move it', () => {
    const { repo } = scratchRepo()
    const project = `sweep-moved-unique-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const tree = createWorktree(repo, id)
    writeFileSync(join(tree.path, 'unique.txt'), 'unique before cleanup\n')
    git(tree.path, 'add', 'unique.txt')
    git(tree.path, 'commit', '-m', 'unique before cleanup')
    const first = git(tree.path, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'fixture-sweep-later-tip', first)
    writeFileSync(join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', 'later.txt')
    git(repo, 'commit', '-m', 'later sweep tip')
    const later = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    git(repo, 'branch', '-D', 'fixture-sweep-later-tip')
    const script = join(repo, 'move-unique-during-sweep.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      `git update-ref "refs/heads/$2" "${later}"\n`)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query(
      `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, started_at=?,
                      worktree_source='recipe' WHERE id=?`,
    ).run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, '2020-01-01T00:00:00.000Z', id)
    db().query(
      `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
       VALUES (?,'full','right','faithful',?)`,
    ).run(id, nowIso())
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'sweep', '--older-than', '0'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('commits unreachable from landing branch main')
      expect(git(repo, 'rev-parse', tree.branch)).toBe(first)
      expect(existsSync(tree.path)).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('stopped runs are swept and their surviving infrastructure is reported by sweep and doctor', () => {
    const { repo } = scratchRepo()
    const project = `stopped-resource-${repo.split('/').pop()}`
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'stopped', repo: project,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    const gone = join(repo, '.claude', 'worktrees', `orch-${id}`)
    db().query(
      `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
       VALUES (?,'full','right','faithful',?)`,
    ).run(id, nowIso())
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, gone, `orch/${id}`, `orch/${id}`, id)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: 'true' } },
    })
    const container = `orch-${id}-postgres-1`
    const volume = `orch-${id}_postgres-data`
    const docker = fakeDocker([container], [volume])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const env = { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' }
      const swept = Bun.spawnSync(
        [process.execPath, CLI, 'sweep', '--older-than', '0'],
        { env, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(swept.exitCode).not.toBe(0)
      expect(swept.stderr.toString()).toContain(container)
      expect(swept.stderr.toString()).toContain(volume)

      const doctor = Bun.spawnSync(
        [process.execPath, CLI, 'doctor'], { env, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(doctor.exitCode).toBe(0)
      expect(doctor.stdout.toString()).toContain(container)
      expect(doctor.stdout.toString()).toContain(`docker rm -f ${container}`)
      expect(doctor.stdout.toString()).toContain(volume)
      expect(doctor.stdout.toString()).toContain(`docker volume rm ${volume}`)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  for (const cleanup of ['discard', 'abandon', 'sweep'] as const) {
    test(`${cleanup} refuses finalization when a run acquires the worktree during removal`, () => {
      const { repo } = scratchRepo()
      const project = `${cleanup}-acquired-tree-${repo.split('/').pop()}`
      const target = addRun({
        agent: 'codex', job: 'implement', status: cleanup === 'abandon' ? 'asking' : 'ok',
        repo: project, startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      })
      const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
      const tree = createWorktree(repo, target)
      const assign = join(repo, 'assign-worktree.ts')
      writeFileSync(assign,
        "import { Database } from 'bun:sqlite'\n" +
        "const database = new Database(process.env.ORCH_DB!)\n" +
        "database.query('UPDATE run SET worktree=? WHERE id=?').run(process.argv[2]!, Number(process.argv[3]))\n")
      const script = join(repo, 'assign-and-remove-worktree.sh')
      writeFileSync(script,
        `"${process.execPath}" "${assign}" "$1" "${owner}"\n` +
        'git worktree remove --force "$1"\n' +
        'git branch -D "$2"\n')
      upsertProject({
        name: project, path: realpathSync(repo),
        settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
      })
      db().query(
        `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?,
                        worktree_source='recipe' WHERE id=?`,
      ).run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, target)
      db().query('UPDATE run SET cwd=? WHERE id=?').run(repo, owner)
      if (cleanup === 'sweep') {
        db().query(
          `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
           VALUES (?,'full','right','faithful',?)`,
        ).run(target, nowIso())
      }
      try {
        const CLI = new URL('cli.ts', import.meta.url).pathname
        const args = cleanup === 'sweep'
          ? ['sweep', '--older-than', '0', '--force']
          : [cleanup, String(target), '--force']
        const p = Bun.spawnSync([process.execPath, CLI, ...args], {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(p.exitCode).not.toBe(0)
        expect(p.stderr.toString()).toContain(String(owner))
        expect(existsSync(tree.path)).toBe(false)
        expect(db().query('SELECT worktree FROM run WHERE id=?').get(owner))
          .toEqual({ worktree: tree.path })
        expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
          .toEqual({ worktree: tree.path })
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })
  }

  test('discard restores and continues when a project tool deletes a moved shared branch', () => {
    const { repo } = scratchRepo()
    const project = `shared-ref-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const branch = `orch/${target}`
    const treePath = join(repo, '.claude', 'worktrees', `orch-${target}`)
    const before = git(repo, 'rev-parse', 'main')

    git(repo, 'checkout', '-b', 'fixture-future-tip')
    writeFileSync(join(repo, 'future.txt'), 'concurrent tip\n')
    git(repo, 'add', 'future.txt')
    git(repo, 'commit', '-m', 'future tip')
    const unobservable = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    git(repo, 'branch', '-D', 'fixture-future-tip')
    git(repo, 'worktree', 'add', '-b', branch, treePath, 'main')

    const script = join(repo, 'move-and-delete-shared-branch.sh')
    writeFileSync(script,
      `git update-ref "refs/heads/$2" "${unobservable}"\n` +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, treePath, branch, branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).toBe(0)
      expect(error).toContain(`project remove tool deleted shared branch ${branch}`)
      expect(error).toContain(`restored ${before}`)
      expect(error).toContain('The tip at deletion was not observable.')
      expect(error).not.toContain(unobservable)
      expect(git(repo, 'rev-parse', branch)).toBe(before)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard accepts branch deletion after every prior owner releases it', () => {
    const { repo } = scratchRepo()
    const project = `released-ref-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const release = join(repo, 'release-owner.ts')
    writeFileSync(release,
      "import { Database } from 'bun:sqlite'\n" +
      "const database = new Database(process.env.ORCH_DB!)\n" +
      "database.query(\"UPDATE run SET status='ok' WHERE id=?\").run(Number(process.argv[2]))\n" +
      "database.query(\"INSERT INTO score (run_id, delivery, quality, fidelity, scored_at) VALUES (?,'full','right','faithful',?)\").run(Number(process.argv[2]), new Date().toISOString())\n")
    const script = join(repo, 'release-and-delete-shared-branch.sh')
    writeFileSync(script,
      `"${process.execPath}" "${release}" "${owner}"\n` +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target)],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: null })
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(target))
        .toEqual({ branch_kept: null })
      expect(db().query('SELECT status FROM run WHERE id=?').get(owner)).toEqual({ status: 'ok' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard leaves a concurrent shared-branch advance at its new tip', () => {
    const { repo } = scratchRepo()
    const project = `advanced-ref-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const branch = `orch/${target}`
    const treePath = join(repo, '.claude', 'worktrees', `orch-${target}`)
    const before = git(repo, 'rev-parse', 'main')

    git(repo, 'checkout', '-b', 'fixture-concurrent-tip')
    writeFileSync(join(repo, 'concurrent.txt'), 'owner advance\n')
    git(repo, 'add', 'concurrent.txt')
    git(repo, 'commit', '-m', 'concurrent owner tip')
    const after = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    git(repo, 'branch', '-D', 'fixture-concurrent-tip')
    git(repo, 'worktree', 'add', '-b', branch, treePath, 'main')

    const script = join(repo, 'advance-shared-branch.sh')
    writeFileSync(script,
      `git update-ref "refs/heads/$2" "${after}"\n` +
      'git worktree remove --force "$1"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, treePath, branch, branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).not.toBe(0)
      expect(error).toContain(`shared branch ${branch} moved from ${before} to ${after}`)
      expect(error).toContain(`run ${owner} owns it`)
      expect(error).toContain(`left at ${after}`)
      expect(git(repo, 'rev-parse', branch)).toBe(after)
      expect(db().query('SELECT branch_kept_tip FROM run WHERE id=?').get(target))
        .toEqual({ branch_kept_tip: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard refuses when another run acquires the branch during the remove tool', () => {
    const { repo } = scratchRepo()
    const project = `acquired-ref-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    const assign = join(repo, 'assign-branch.ts')
    writeFileSync(assign,
      "import { Database } from 'bun:sqlite'\n" +
      "const database = new Database(process.env.ORCH_DB!)\n" +
      "database.query('UPDATE run SET branch=? WHERE id=?').run(process.argv[2]!, Number(process.argv[3]))\n")
    const script = join(repo, 'assign-and-delete-shared-branch.sh')
    writeFileSync(script,
      `"${process.execPath}" "${assign}" "$2" "${owner}"\n` +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=? WHERE id=?').run(repo, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).not.toBe(0)
      expect(error).toContain(`Run ${owner} acquired branch ${tree.branch} during cleanup`)
      expect(error).toContain(`deleted shared branch ${tree.branch}; restored ${tip}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch FROM run WHERE id=?').get(owner))
        .toEqual({ branch: tree.branch })
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
