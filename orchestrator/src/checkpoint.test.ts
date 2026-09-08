import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { addRun, db, declaredCreate, hermeticGitEnv, prepareSharedRefGuard, run, upsertProject, validateCliArgs } from '../test/fixture.ts'
import {
  checkpointResumeContext, checkpointRun, PRESERVATION_FAILED_FILE, readTaskPointer,
  recordFailedIdlePreservation,
} from './checkpoint.ts'
import { runEventsPath } from './events.ts'
import { squashCheckpointCommits } from './landing.ts'
import { installTestTransport, type AgentTransport, type TransportResult } from './transport.ts'

const roots: string[] = []
afterEach(() => {
  installTestTransport(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orch-checkpoint-'))
  roots.push(root)
  const g = (...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd: root, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  g('init', '-b', 'main')
  g('config', 'user.name', 'Test')
  g('config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'file.txt'), 'base\n')
  g('add', 'file.txt'); g('commit', '-m', 'DEV-374 base')
  const tree = join(root, 'tree')
  g('worktree', 'add', '-b', 'DEV-374-checkpoint', tree, 'main')
  return tree
}

function git(root: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd: root, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

describe('failed idle-kill preservation', () => {
  test('records the failure and snapshots scratch before standing down', () => {
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const scratch = mkdtempSync(join(tmpdir(), 'orch-preserve-')); roots.push(scratch)
    const tree = mkdtempSync(join(tmpdir(), 'orch-tree-')); roots.push(tree)
    writeFileSync(join(scratch, 'notes.txt'), 'still on disk\n')
    writeFileSync(join(tree, 'worker.txt'), 'uncommitted\n')
    const result = recordFailedIdlePreservation({
      runId, scratchDir: scratch, worktree: tree, error: 'git status failed',
    })
    const note = JSON.parse(readFileSync(result.notePath, 'utf8')) as {
      preservation_failed: boolean; error: string; files: string[]
    }
    expect(note.preservation_failed).toBe(true)
    expect(note.error).toBe('git status failed')
    expect(note.files).toContain('worker.txt')
    expect(readFileSync(runEventsPath(runId), 'utf8')).toContain('preservation failed: git status failed')
    expect(existsSync(join(result.snapshotDir, PRESERVATION_FAILED_FILE))).toBe(true)
    expect(readFileSync(join(result.snapshotDir, 'notes.txt'), 'utf8')).toBe('still on disk\n')
  })
})

describe('harness-owned checkpoints', () => {
  test('commits tracked work, records progress, and leaves untracked files alone', () => {
    const root = repo()
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const scratch = mkdtempSync(join(tmpdir(), 'orch-progress-')); roots.push(scratch)
    writeFileSync(join(root, 'file.txt'), 'checkpointed\n')
    writeFileSync(join(root, 'untracked.txt'), 'not checkpointed\n')
    writeFileSync(join(scratch, 'progress.json'), JSON.stringify({ task_pointer: 'item 2 complete', note: 'ok' }))
    expect(readTaskPointer(scratch)).toBe('item 2 complete')
    const result = checkpointRun({ database: db(), runId, worktree: root,
      branch: 'DEV-374-checkpoint', taskKey: 'DEV-374', scratchDir: scratch,
      guardEnvironment: prepareSharedRefGuard(root, 'refs/heads/DEV-374-checkpoint'), final: true })
    expect(result.created).toBe(true)
    expect(git(root, 'show', '-s', '--format=%s')).toBe(`DEV-374 checkpoint run ${runId} #1`)
    expect(git(root, 'status', '--porcelain')).toBe('?? untracked.txt')
    expect(db().query('SELECT commit_sha,task_pointer,final FROM run_checkpoint WHERE run_id=?').get(runId))
      .toEqual({ commit_sha: result.commit, task_pointer: 'item 2 complete', final: 1 })
    expect(checkpointResumeContext(db(), runId, root)).toContain('Last completed item: item 2 complete')
  })

  test('a changed HEAD is refused adjacent to commit and records the refusal', () => {
    const root = repo()
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const scratch = mkdtempSync(join(tmpdir(), 'orch-progress-')); roots.push(scratch)
    writeFileSync(join(root, 'file.txt'), 'dirty\n')
    git(root, 'switch', '-c', 'other-branch')
    const before = git(root, 'rev-parse', 'HEAD')
    const result = checkpointRun({ database: db(), runId, worktree: root,
      branch: 'DEV-374-checkpoint', taskKey: 'DEV-374', scratchDir: scratch,
      guardEnvironment: prepareSharedRefGuard(root, 'refs/heads/DEV-374-checkpoint') })
    expect(result.created).toBe(false)
    expect(result.error).toContain('expected branch DEV-374-checkpoint, found other-branch')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(runEventsPath(runId), 'utf8')).toContain('checkpoint refused')
  })

  test('the shared-ref guard refuses a checkpoint moving any other ref', () => {
    const root = repo()
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const scratch = mkdtempSync(join(tmpdir(), 'orch-progress-')); roots.push(scratch)
    writeFileSync(join(root, 'file.txt'), 'dirty\n')
    const before = git(root, 'rev-parse', 'HEAD')
    const result = checkpointRun({ database: db(), runId, worktree: root,
      branch: 'DEV-374-checkpoint', taskKey: 'DEV-374', scratchDir: scratch,
      guardEnvironment: prepareSharedRefGuard(root, 'refs/heads/not-the-run-branch') })
    expect(result.created).toBe(false)
    expect(result.error).toContain('this worker may update only refs/heads/not-the-run-branch')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before)
  })

  test('an index lock records a run event and creates no checkpoint', () => {
    const root = repo()
    const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    const scratch = mkdtempSync(join(tmpdir(), 'orch-progress-')); roots.push(scratch)
    writeFileSync(join(root, 'file.txt'), 'dirty\n')
    const gitDir = git(root, 'rev-parse', '--git-dir')
    writeFileSync(resolve(root, gitDir, 'index.lock'), 'held')
    const before = git(root, 'rev-parse', 'HEAD')
    const result = checkpointRun({ database: db(), runId, worktree: root,
      branch: 'DEV-374-checkpoint', taskKey: 'DEV-374', scratchDir: scratch,
      guardEnvironment: prepareSharedRefGuard(root, 'refs/heads/DEV-374-checkpoint') })
    expect(result.created).toBe(false)
    expect(result.error).toContain('index.lock')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(runEventsPath(runId), 'utf8')).toContain('index.lock')
  })

  test('landing folds checkpoints into the following worker commit and can preserve them', () => {
    for (const preserve of [false, true]) {
      const root = repo()
      const base = git(root, 'rev-parse', 'main')
      writeFileSync(join(root, 'file.txt'), 'checkpoint\n')
      git(root, 'add', '-u'); git(root, 'commit', '-m', 'DEV-374 checkpoint run 99 #1')
      writeFileSync(join(root, 'worker.txt'), 'worker\n')
      git(root, 'add', 'worker.txt'); git(root, 'commit', '-m', 'DEV-374 worker item')
      if (!preserve) squashCheckpointCommits(root, base)
      const subjects = git(root, 'log', '--format=%s', `${base}..HEAD`).split('\n')
      expect(subjects).toEqual(preserve
        ? ['DEV-374 worker item', 'DEV-374 checkpoint run 99 #1']
        : ['DEV-374 worker item'])
      expect(git(root, 'show', 'HEAD:file.txt')).toBe('checkpoint')
    }
  })

  test('a trailing checkpoint stays visible after landing normalization', () => {
    const root = repo()
    const base = git(root, 'rev-parse', 'main')
    writeFileSync(join(root, 'file.txt'), 'trailing\n')
    git(root, 'add', '-u'); git(root, 'commit', '-m', 'DEV-374 checkpoint run 99 #1')
    squashCheckpointCommits(root, base)
    expect(git(root, 'show', '-s', '--format=%s')).toBe('DEV-374 checkpoint run 99 #1')
  })

  test('landing accepts the exact checkpoint preservation flag', () => {
    expect(() => validateCliArgs(['land', 'DEV-374-checkpoint', '--keep-checkpoints'])).not.toThrow()
  })

  for (const failure of [
    { kind: 'timeout', error: 'the worker timed out at the run bound' },
    { kind: 'quota', error: "You've hit your usage limit" },
  ] as const) test(`${failure.kind} preserves modified work on the run branch`, async () => {
    const root = repo()
    const main = resolve(root, git(root, 'rev-parse', '--git-common-dir'), '..')
    const createScript = `const {spawnSync}=require('child_process');const {mkdirSync}=require('fs');` +
      `const {join}=require('path');const branch=process.argv.at(-1);const root=${JSON.stringify(main)};` +
      `const path=join(root,'trees',branch);mkdirSync(join(root,'trees'),{recursive:true});` +
      `const p=spawnSync('git',['worktree','add','-b',branch,path,'main'],{cwd:root,stdio:['ignore','ignore','inherit']});` +
      `if(p.status)process.exit(p.status);process.stdout.write(path+'\\n')`
    const createPath = join(main, 'create.cjs')
    writeFileSync(createPath, createScript)
    upsertProject({ name: `checkpoint-${failure.kind}`, path: main,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate(process.execPath, [createPath, '{branch}']),
        branch: '{key}-orch-{id}',
      } } })
    const transport: AgentTransport = {
      name: 'cli',
      async start(opts) {
        const result: TransportResult = {
          stdout: '', stderr: failure.error, raw: failure.error,
          parsed: { text: '', tokens: null, costUsd: null, error: failure.error },
          output: '', tokens: null, costUsd: null, sessionId: 'checkpoint-session',
          stopReason: null, error: failure.error, exitCode: 1, pid: 0, events: [],
          asking: false, failureKind: failure.kind, status: 'failed', questions: [],
        }
        return {
          pid: 0, kill() {}, async prompt() {}, async *events() {}, async cancel() {},
          async collect() {
            writeFileSync(join(opts.cwd, 'file.txt'), `${failure.kind}\n`)
            return result
          },
        }
      },
      prompt(handle, text) { return handle.prompt(text) },
      events(handle) { return handle.events() },
      cancel(handle) { return handle.cancel() },
      resume(opts) { return this.start(opts) },
    }
    installTestTransport(transport)
    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    let runId: number | null = null
    let thrown = ''
    try {
      const result = await run({ job: 'implement', prompt: 'edit the tracked file', cwd: main,
        agent: 'codex', key: 'DEV-374', noFailover: true })
      runId = result.id
    } catch (error) {
      thrown = String((error as Error).message)
      runId = (error as Error & { runId?: number }).runId ?? null
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
    }
    expect(runId, thrown).not.toBeNull()
    const row = db().query(
      'SELECT failure_kind,work_preserved,worktree,branch,error FROM run WHERE id=?',
    ).get(runId) as { failure_kind: string; work_preserved: number; worktree: string; branch: string; error: string }
    expect(row.failure_kind, row.error).toBe(failure.kind)
    expect(row.work_preserved).toBe(1)
    expect(git(row.worktree, 'show', '-s', '--format=%s')).toBe(`DEV-374 checkpoint run ${runId} #1`)
    expect(git(main, 'rev-parse', row.branch)).toBe(git(row.worktree, 'rev-parse', 'HEAD'))
  })

  test('SIGTERM checkpoints a dirty live writing run as final', async () => {
    const root = repo()
    const main = resolve(root, git(root, 'rev-parse', '--git-common-dir'), '..')
    const project = `checkpoint-signal-${Date.now()}`
    const createPath = join(main, 'create-signal.cjs')
    writeFileSync(createPath,
      `const {spawnSync}=require('child_process');const {mkdirSync}=require('fs');` +
      `const {join}=require('path');const branch=process.argv.at(-1);const root=${JSON.stringify(main)};` +
      `const path=join(root,'trees',branch);mkdirSync(join(root,'trees'),{recursive:true});` +
      `const p=spawnSync('git',['worktree','add','-b',branch,path,'main'],{cwd:root,stdio:['ignore','ignore','inherit']});` +
      `if(p.status)process.exit(p.status);process.stdout.write(path+'\\n')`)
    upsertProject({ name: project, path: main,
      settings: { trunk: 'main', worktree: {
        create: declaredCreate(process.execPath, [createPath, '{branch}']),
        branch: '{key}-orch-{id}',
      } } })
    const runner = join(main, 'signal-runner.ts')
    const runModule = new URL('./run.ts', import.meta.url).href
    const transportModule = new URL('./transport.ts', import.meta.url).href
    writeFileSync(runner, `
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { run } from ${JSON.stringify(runModule)}
      import { installTestTransport } from ${JSON.stringify(transportModule)}
      installTestTransport({ name: 'cli', async start(opts) {
        writeFileSync(join(opts.cwd, 'file.txt'), 'signal dirty\\n')
        return { pid: 0, kill() {}, async prompt() {}, async *events() {}, async cancel() {},
          async collect() { await new Promise(resolve => setTimeout(resolve, 60_000)); throw new Error('late') } }
      }, prompt(h,t){return h.prompt(t)}, events(h){return h.events()}, cancel(h){return h.cancel()}, resume(o){return this.start(o)} })
      await run({ job: 'implement', prompt: 'dirty then wait', cwd: ${JSON.stringify(main)},
        agent: 'codex', key: 'DEV-374', noFailover: true })
    `)
    const child = Bun.spawn([process.execPath, runner], {
      cwd: main, env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    let row: { id: number; worktree: string; branch: string } | null = null
    for (let i = 0; i < 200; i++) {
      row = db().query(
        `SELECT id,worktree,branch FROM run WHERE repo=? AND status='running' AND worktree IS NOT NULL
          AND agent_pid IS NOT NULL ORDER BY id DESC LIMIT 1`,
      ).get(project) as typeof row
      if (row) break
      await Bun.sleep(10)
    }
    expect(row).not.toBeNull()
    await Bun.sleep(100)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(130)
    const checkpoint = db().query(
      'SELECT commit_sha,final FROM run_checkpoint WHERE run_id=? ORDER BY checkpoint_no DESC LIMIT 1',
    ).get(row!.id) as { commit_sha: string; final: number } | null
    expect(checkpoint?.final).toBe(1)
    expect(git(row!.worktree, 'rev-parse', 'HEAD')).toBe(checkpoint!.commit_sha)
    expect((db().query('SELECT work_preserved FROM run WHERE id=?').get(row!.id) as
      { work_preserved: number }).work_preserved).toBe(1)
  }, 30_000)
})
