import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, compoundCreate, createWithTool, createWorktree, db, declaredCreate, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, nowIso, prepareSharedRefGuard, prepareWorktreeObjects, processStartTime, projectLockDir, reclaimStaleProjectLock, removeFor, resolveBase, runJob, staleProjectLockHolder, upsertProject, withProjectLock, withWorktreeCreateLock, worktreeDescribeFixture } from '../fixture.ts'


describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo, markScratchRepoOwner } = worktreeDescribeFixture()
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
    new URL('../../src/worktree.ts', import.meta.url).href, repo, ready, release,
  ], { env: { ...hermeticGitEnv(), XDG_RUNTIME_DIR: xdgOne }, stdout: 'pipe', stderr: 'pipe' })
  try {
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5)
    expect(existsSync(ready)).toBe(true)
    const contender = Bun.spawnSync([process.execPath, '-e',
      `const{withProjectLock}=await import(process.argv[1]);withProjectLock(process.argv[2],'landing',{session:'two',what:'base-two'},()=>{},30,true)`,
      new URL('../../src/worktree.ts', import.meta.url).href, linked,
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

test('legacy and kernel lock holders exclude each other in both directions', async () => {
  const { repo } = scratchRepo()
  const common = realpathSync(join(repo, '.git'))
  const legacy = join(common, 'orch-landing.lock')
  const module = new URL('../../src/worktree.ts', import.meta.url).href
  const oldReady = join(repo, 'old-ready')
  const oldRelease = join(repo, 'old-release')
  const newReady = join(repo, 'new-ready')
  const newRelease = join(repo, 'new-release')
  const oldHolder = Bun.spawn([process.execPath, '-e',
    `const{existsSync,mkdirSync,rmSync,writeFileSync}=await import('node:fs');const[path,ready,release]=process.argv.slice(1);mkdirSync(path);writeFileSync(path+'/owner',JSON.stringify({pid:process.pid,startTime:null,incarnation:'legacy-holder',session:'legacy',what:'legacy landing',since:new Date().toISOString()}));writeFileSync(ready,'');while(!existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);rmSync(path,{recursive:true})`,
    legacy, oldReady, oldRelease,
  ], { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  try {
    for (let i = 0; i < 200 && !existsSync(oldReady); i++) await Bun.sleep(5)
    expect(existsSync(oldReady)).toBe(true)
    expect(() => withWorktreeCreateLock(repo, () => undefined, 30)).not.toThrow()
    expect(() => withProjectLock(
      repo, 'landing', { session: 'new', what: 'new landing' }, () => undefined, 30, true,
    )).toThrow('timed out')
    writeFileSync(oldRelease, '')
    expect(await oldHolder.exited).toBe(0)

    const newHolder = Bun.spawn([process.execPath, '-e',
      `const{existsSync,writeFileSync}=await import('node:fs');const{withProjectLock}=await import(process.argv[1]);withProjectLock(process.argv[2],'landing',{session:'new',what:'new landing'},()=>{writeFileSync(process.argv[3],'');while(!existsSync(process.argv[4]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)},5000,true)`,
      module, repo, newReady, newRelease,
    ], { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    try {
      for (let i = 0; i < 200 && !existsSync(newReady); i++) await Bun.sleep(5)
      expect(existsSync(newReady)).toBe(true)
      expect(existsSync(legacy)).toBe(true)
      const oldTaker = Bun.spawnSync([process.execPath, '-e',
        `const{existsSync,mkdirSync}=require('node:fs');if(!existsSync(process.argv[1]))process.exit(20);try{mkdirSync(process.argv[1]);process.exit(21)}catch(error){if(error.code!=='EEXIST')throw error;process.exit(19)}`, legacy,
      ], { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      expect(oldTaker.exitCode).toBe(19)
    } finally {
      writeFileSync(newRelease, '')
      await newHolder.exited
    }
  } finally {
    writeFileSync(oldRelease, '')
    oldHolder.kill()
    await oldHolder.exited
    rmSync(repo, { recursive: true, force: true })
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
      `import { withProjectLock } from ${JSON.stringify(new URL('../../src/worktree.ts', import.meta.url).href)}\n` +
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
    const module = new URL('../../src/worktree.ts', import.meta.url).href
    const child = `
      const { registerStandardHooks } = await import(new URL('./store-hooks.ts', process.argv[1])); registerStandardHooks(); const { createWithTool } = await import(process.argv[1])
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
      new URL('../../src/worktree.ts', import.meta.url).href, repo, ready, release,
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
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
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

test('discard inventories leaks after successfully restoring a shared branch', () => {
    const { repo } = scratchRepo()
    const project = `restored-leak-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    const script = join(repo, 'delete-shared-but-leak.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    const docker = fakeDocker([`orch-${target}-leaked`], [])
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: {
            ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).not.toBe(0)
      expect(error).toContain(`deleted shared branch ${tree.branch}; restored ${tip}`)
      expect(error).toContain(`container orch-${target}-leaked leaked by project ${project}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard targets the project repository under a managed-worker Git environment', () => {
    const { repo } = scratchRepo()
    const { repo: workerRepo } = scratchRepo()
    const worker = createWorktree(workerRepo, 1701)
    const managedEnv = {
      ...prepareWorktreeObjects(worker.path),
      ...prepareSharedRefGuard(worker.path, `refs/heads/${worker.branch}`),
    }
    const project = `managed-cleanup-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: {
        trunk: 'main',
        worktree: {
          remove: `${hermeticGitCommand} worktree remove --force {path}; ` +
            `${hermeticGitCommand} branch -D {branch}`,
        },
      },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: {
            ...process.env, ...managedEnv, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).toContain(`deleted shared branch ${tree.branch}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(p.stderr.toString()).not.toContain('nonexistent object')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(workerRepo, { recursive: true, force: true })
    }
  })

  test('a refused branch restore records and publishes its recovery tip', () => {
    const { repo } = scratchRepo()
    const project = `refused-restore-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    const hooks = join(repo, 'refusing-hooks')
    mkdirSync(hooks)
    const hook = join(hooks, 'reference-transaction')
    writeFileSync(hook,
      '#!/bin/sh\n' +
      'zero=0000000000000000000000000000000000000000\n' +
      'while read old new ref; do [ "$old" = "$zero" ] && exit 1; done\n' +
      'exit 0\n')
    chmodSync(hook, 0o755)
    const script = join(repo, 'delete-before-refused-restore.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n' +
      `git config core.hooksPath "${hooks}"\n`)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).not.toBe(0)
      expect(error).toContain(`branch ${tree.branch} should have been restored to ${tip}`)
      expect(error).toContain('ref write was refused')
      expect(error).toContain('Restore it from the main checkout.')
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept, branch_kept_tip FROM run WHERE id=?').get(target))
        .toEqual({ branch_kept: tree.branch, branch_kept_tip: tip })
      const shown = Bun.spawnSync([process.execPath, CLI, 'run', String(target)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(shown.exitCode).toBe(0)
      expect(JSON.parse(shown.stdout.toString())).toMatchObject({
        branch_kept: tree.branch, branch_kept_tip: tip,
      })
    } finally {
      git(repo, 'config', '--unset', 'core.hooksPath')
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard reports Docker resources left by a successful project remove and keeps the pointer', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'leaking-tool' })
    const tree = {
      path: join(repo, '.claude', 'worktrees', `DEV-207-orch-${id}`),
      branch: `orch/${id}`,
      mintedBranch: `orch/${id}`,
    }
    git(repo, 'worktree', 'add', '-b', tree.branch, tree.path, 'main')
    const script = join(repo, 'remove-but-leak.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'leaking-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    const docker = fakeDocker(
      [`orch-${id}-postgres-1`, 'unrelated-container'],
      [`orch-${id}_adanim-pgdata`, 'unrelated-volume'],
    )
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(`container orch-${id}-postgres-1 leaked by project leaking-tool`)
      expect(p.stderr.toString()).toContain(`volume orch-${id}_adanim-pgdata leaked by project leaking-tool`)
      expect(p.stderr.toString()).not.toContain('unrelated-container')
      expect(existsSync(tree.path)).toBe(false)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('discard refuses unverifiable cleanup when Docker inventory is unavailable', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'inventory-tool' })
    const tree = createWorktree(repo, id)
    const script = join(repo, 'remove-before-inventory.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'inventory-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    const docker = fakeDockerCommand("echo 'docker unavailable' >&2; exit 127")
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('inventory unavailable')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('discard bounds an unresponsive Docker inventory and keeps the pointer', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'slow-inventory-tool' })
    const tree = createWorktree(repo, id)
    const script = join(repo, 'remove-before-slow-inventory.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'slow-inventory-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    const docker = fakeDockerCommand('sleep 5')
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const started = Date.now()
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      // The bound derives from the inventory timeout the shard runner hands
      // this file (run-gate sets it per size class), not from a quiet-machine
      // literal: discard takes two bounded inventory calls (containers, then
      // volumes), so it must return within twice that timeout plus overhead.
      const inventoryMs = Number(process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS ?? 1000)
      expect(Date.now() - started).toBeLessThan(inventoryMs * 2 + 2_000)
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('inventory unavailable')
      expect(p.stderr.toString()).toContain('timed out')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  }, 15_000)

  test('abandon cleans an absent worktree identity through project removal', () => {
    const { repo } = scratchRepo()
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'asking', repo: 'gone-tree-tool',
    })
    const gone = join(repo, '.claude', 'worktrees', `orch-${id}`)
    const called = join(repo, 'remove-called')
    upsertProject({
      name: 'gone-tree-tool', path: realpathSync(repo),
      settings: {
        trunk: 'main', worktree: { remove: `printf removed > "${called}"` },
      },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, gone, `orch/${id}`, `orch/${id}`, id)
    const docker = fakeDocker([], [])
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(called)).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('discard --force does not override a project tool for a tree orch did not create', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'operator-tree')
    git(repo, 'worktree', 'add', '-b', 'operator-tree', path, 'main')
    writeFileSync(join(path, 'operator.txt'), 'protected work\n')
    upsertProject({
      name: 'refusing-operator-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'protected operator work' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(path, 'operator-tree', id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('protected operator work')
      expect(p.stderr.toString()).toContain(
        "--force will not override a project tool's refusal unless the tree carries orch's " +
        '.orch-run ownership marker',
      )
      expect(existsSync(path)).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard --force removes a dirty orch-created tree after its project tool refuses', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 889)
    writeFileSync(join(tree.path, 'scratch.txt'), 'worker scratch state\n')
    upsertProject({
      name: 'refusing-orch-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'dirty tree refused' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard on an unregistered repository uses git removal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 882)
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const env = { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'discard-actor' }
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env, stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query(
        'SELECT action, actor_session FROM run_mutation_audit WHERE run_id=? ORDER BY rowid',
      ).all(id)).toEqual([
        { action: 'adopt', actor_session: 'discard-actor' },
        { action: 'discard', actor_session: 'discard-actor' },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard keeps a branch with an unmerged commit and records it', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 883)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const script = join(repo, 'remove-and-delete.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'protected-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET repo=?, cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run('protected-tool', repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) reachable only from this branch — merge it, or ` +
        `orch discard ${id} --force to delete it after checking no other run owns it`,
      )
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })

      const owner = addRun({
        agent: 'codex', job: 'implement', status: 'running', repo: 'protected-tool',
      })
      db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
      const refused = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr.toString()).toContain(
        `branch ${tree.branch} is still evidence owned by run ${owner}`,
      )
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      db().query('UPDATE run SET branch=NULL WHERE id=?').run(owner)

      const forced = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(forced.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('discard --force deletes a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 884)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard never rewinds a protected branch moved by the project remove tool', () => {
    const { repo } = scratchRepo()
    const project = `moved-protected-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', repo: project })
    const tree = createWorktree(repo, id)
    writeFileSync(join(tree.path, 'unique.txt'), 'first tip\n')
    git(tree.path, 'add', 'unique.txt')
    git(tree.path, 'commit', '-m', 'first unique tip')
    const first = git(tree.path, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'fixture-later-tip', first)
    writeFileSync(join(repo, 'later.txt'), 'later tip\n')
    git(repo, 'add', 'later.txt')
    git(repo, 'commit', '-m', 'later unique tip')
    const later = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    git(repo, 'branch', '-D', 'fixture-later-tip')
    const script = join(repo, 'move-protected-branch.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      `git update-ref "refs/heads/$2" "${later}"\n`)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(
        `protected branch ${tree.branch} moved from ${first} to ${later}`,
      )
      expect(p.stderr.toString()).toContain(`left at ${later}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(later)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard deletes a branch whose commit is merged into trunk', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 885)
    writeFileSync(join(tree.path, 'merged.txt'), 'merged work\n')
    git(tree.path, 'add', 'merged.txt')
    git(tree.path, 'commit', '-m', 'merged work')
    git(repo, 'merge', '--ff-only', tree.branch)
    upsertProject({ name: 'merged-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('abandon keeps a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 886)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    upsertProject({ name: 'abandon-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toContain(tree.branch)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard without a configured trunk still deletes a branch with no unique commits', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 887)
    upsertProject({ name: 'no-trunk-discard', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('automatic abandon without a configured trunk removes a disposable branch', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 888)
    upsertProject({ name: 'no-trunk-abandon', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard does not keep a branch merely ahead of a stale local trunk', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    upsertProject({
      name: 'stale-trunk', path: realpathSync(repo), settings: { trunk: 'main' },
    })
    const tree = createWorktree(repo, 890, 'origin/main')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    try {
      expect(git(repo, 'rev-list', '--count', `main..${tree.branch}`)).not.toBe('0')
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard still keeps unique commits when the local trunk is stale', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    upsertProject({
      name: 'stale-trunk-unique', path: realpathSync(repo), settings: { trunk: 'main' },
    })
    const tree = createWorktree(repo, 891, 'origin/main')
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: deleting it would lose commits reachable from no other ref; ` +
        `1 commit(s) after the cut`,
      )
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('resumed child cleanup removes only the discarding run guard, not the marker owner guard', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-resumed-cleanup-'))
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(['add', 'base.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.email=orch-test@example.invalid', '-c', 'user.name=Orch Test',
        'commit', '-m', 'base']).exitCode).toBe(0)
      const root = 251
      const resumedChild = 252
      const tree = createWorktree(repo, root)
      const rootGuard = prepareSharedRefGuard(tree.path)
      const childGuard = join(realpathSync(repo), '.git', 'orch-guards', String(resumedChild))
      mkdirSync(childGuard)

      expect(removeFor(tree, repo, false, false, resumedChild).removed).toBe(true)
      expect(existsSync(rootGuard.GIT_CONFIG_VALUE_0)).toBe(true)
      expect(existsSync(childGuard)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
