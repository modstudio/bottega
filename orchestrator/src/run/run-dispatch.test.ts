import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { detach, spawnCwd } from './run-dispatch.ts'

const originalExecPath = process.env.ORCH_EXEC_PATH
const originalDepth = process.env.ORCH_DEPTH
afterEach(() => {
  mock.restore()
  if (originalExecPath === undefined) delete process.env.ORCH_EXEC_PATH
  else process.env.ORCH_EXEC_PATH = originalExecPath
  if (originalDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = originalDepth
})

test('detached MCP preflight ensures the declared project stack before probing', async () => {
  upsertProject({
    name: 'detached-mcp-stack-fixture',
    path: import.meta.dir,
    settings: { mainStack: { consumers: ['mcp'], requiredServices: ['db'] } },
  })
  const dockerCalls: string[][] = []
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: object) => {
    if (args[0] !== 'docker') return originalSpawnSync(args, options as never)
    dockerCalls.push(args)
    return {
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('daemon unavailable'),
      success: false,
      exitedDueToTimeout: false,
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)

  await expect(
    detach(
      'review-lens',
      'MCP stack preflight fixture',
      {
        cwd: import.meta.dir,
        repo: 'detached-mcp-stack-fixture',
        mcp: true,
        lens: 'correctness',
      },
      'codex',
    ),
  ).rejects.toThrow('daemon unavailable')
  expect(dockerCalls).toEqual([
    ['docker', 'compose', 'ps', '--status', 'running', '--services', 'db'],
  ])
})

test('a detached worker starts in its recorded directory, or the fallback when that is gone', () => {
  expect(spawnCwd('/unregistered', null, false, true, '/fallback')).toBe('/unregistered')
  expect(spawnCwd('/unregistered', null, false, false, '/fallback')).toBe('/fallback')
})

test('disposable-tree mutation: a registered project coordinator starts in the main checkout', () => {
  expect(spawnCwd('/repo/.claude/worktrees/live', '/repo', true, true, '/fallback')).toBe('/repo')
})

test('a post-insert launch failure marks the reserved row failed/harness', async () => {
  process.env.ORCH_EXEC_PATH = `${dir}/missing-coordinator`
  process.env.ORCH_DEPTH = '0'

  await expect(detach('summarize', 'detach handoff fixture', { cwd: dir })).rejects.toThrow()

  expect(
    db()
      .query(
        `SELECT status, failure_kind, error FROM run
         WHERE prompt_head='detach handoff fixture' ORDER BY id DESC LIMIT 1`,
      )
      .get(),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: expect.stringContaining('detach handoff failed during await coordinator spawn'),
  })
})

test('detach sends coordinator stdout and stderr to an append log descriptor', async () => {
  process.env.ORCH_DEPTH = '0'
  let stdio: unknown
  const fakeSpawn = ((
    _execPath: string,
    _args: readonly string[],
    options: { stdio?: unknown },
  ) => {
    stdio = options.stdio
    const child = new EventEmitter() as ChildProcess
    Object.defineProperty(child, 'pid', { value: 4_194_303 })
    child.unref = () => child
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as typeof spawn

  await detach('summarize', 'coordinator log fixture', { cwd: dir }, undefined, fakeSpawn)

  expect(stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)])
  const descriptors = stdio as ['ignore', number, number]
  expect(descriptors[1]).toBeGreaterThan(2)
  expect(descriptors[2]).toBe(descriptors[1])
})
