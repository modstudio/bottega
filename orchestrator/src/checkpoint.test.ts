import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, db, declaredCreate, hermeticGitEnv, run, upsertProject, validateCliArgs } from '../test/fixture.ts'
import { checkpointResumeContext, checkpointRun, readTaskPointer } from './checkpoint.ts'
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
  g('switch', '-c', 'DEV-374-checkpoint')
  return root
}

function git(root: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd: root, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

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
      branch: 'DEV-374-checkpoint', taskKey: 'DEV-374', scratchDir: scratch, final: true })
    expect(result.created).toBe(true)
    expect(git(root, 'show', '-s', '--format=%s')).toBe(`DEV-374 checkpoint run ${runId} #1`)
    expect(git(root, 'status', '--porcelain')).toBe('?? untracked.txt')
    expect(db().query('SELECT commit_sha,task_pointer,final FROM run_checkpoint WHERE run_id=?').get(runId))
      .toEqual({ commit_sha: result.commit, task_pointer: 'item 2 complete', final: 1 })
    expect(checkpointResumeContext(db(), runId, root)).toContain('Last completed item: item 2 complete')
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
    const createScript = `const {spawnSync}=require('child_process');const {mkdirSync}=require('fs');` +
      `const {join}=require('path');const branch=process.argv.at(-1);const root=${JSON.stringify(root)};` +
      `const path=join(root,'trees',branch);mkdirSync(join(root,'trees'),{recursive:true});` +
      `const p=spawnSync('git',['worktree','add','-b',branch,path,'main'],{cwd:root,stdio:['ignore','ignore','inherit']});` +
      `if(p.status)process.exit(p.status);process.stdout.write(path+'\\n')`
    const createPath = join(root, 'create.cjs')
    writeFileSync(createPath, createScript)
    upsertProject({ name: `checkpoint-${failure.kind}`, path: root,
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
      const result = await run({ job: 'implement', prompt: 'edit the tracked file', cwd: root,
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
    expect(git(root, 'rev-parse', row.branch)).toBe(git(row.worktree, 'rev-parse', 'HEAD'))
  })
})
