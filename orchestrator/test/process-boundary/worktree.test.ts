import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { db } from '../../src/db.ts'
import { upsertProject } from '../../src/projects.ts'
import { run as runJob } from '../../src/run.ts'
import { orphanSafety } from '../../src/worktree-attribution.ts'
import { createWorktree, withProjectLock, withWorktreeCreateLock } from '../../src/worktree.ts'
import { hermeticGitCommand, hermeticGitEnv } from '../fixtures/git.ts'
import { addRun } from '../fixtures/store.ts'
import { compoundCreate, worktreeDescribeFixture } from '../fixtures/worktree.ts'

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
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
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

})

describe('registered worktree teardown boundary', () => {
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}
test('a registered worktree is removable whether or not it is dirty', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-orphan-'))
    const tree = join(repo, '.claude', 'worktrees', 'orphan')
    try {
      git(repo, 'init', '-b', 'main')
      git(repo, 'config', 'user.email', 'orch-test@example.invalid')
      git(repo, 'config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, 'add', 'kept.txt')
      git(repo, 'commit', '-m', 'base')
      git(repo, 'worktree', 'add', '-b', 'orphan', tree, 'main')

      expect(orphanSafety(tree, repo, 'main')).toMatchObject({ removable: true, branch: 'orphan' })
      writeFileSync(join(tree, 'new.txt'), 'unique\n')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: true, branch: 'orphan',
      })
      git(tree, 'add', 'new.txt')
      git(tree, 'commit', '-m', 'unique')
      expect(orphanSafety(tree, repo, 'main')).toMatchObject({
        removable: true, branch: 'orphan',
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
