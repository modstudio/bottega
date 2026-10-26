import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { clearMigrationDrain, setMigrationDrain } from '../database/migration-drain.ts'
import { upsertProject } from '../project/projects.ts'
import { detach, spawnCwd } from './run-dispatch.ts'
import { RUN_REFERENCE_REFUSAL } from './run-task-reference.ts'

const originalExecPath = process.env.BOTTEGA_EXEC_PATH
const originalDepth = process.env.BOTTEGA_DEPTH
beforeEach(() => {
  upsertProject({ recordId: newRecordId(), name: 'dispatch-fixture', path: dir })
  upsertProject({ recordId: newRecordId(), name: 'dispatch-repo-fixture', path: import.meta.dir })
})
afterEach(() => {
  mock.restore()
  if (originalExecPath === undefined) delete process.env.BOTTEGA_EXEC_PATH
  else process.env.BOTTEGA_EXEC_PATH = originalExecPath
  if (originalDepth === undefined) delete process.env.BOTTEGA_DEPTH
  else process.env.BOTTEGA_DEPTH = originalDepth
})

test('detached MCP preflight ensures the declared project stack before probing', async () => {
  upsertProject({
    recordId: newRecordId(),
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

test('detached dispatch refuses an unlinked non-probe before reserving a row', async () => {
  process.env.BOTTEGA_DEPTH = '0'
  await expect(
    detach('summarize', 'unlinked detached fixture', { cwd: '/unregistered' }),
  ).rejects.toThrow(RUN_REFERENCE_REFUSAL)
  expect(
    db().query("SELECT 1 FROM run WHERE prompt_head='unlinked detached fixture'").get(),
  ).toBeNull()
})

test('a findings dispatch carries its resolved round role to the coordinator', async () => {
  process.env.BOTTEGA_DEPTH = '0'
  let coordinatorSpec: { reviewRole?: string } | undefined
  const spawnCoordinator = ((_executable: string, args: string[]) => {
    coordinatorSpec = JSON.parse(args.at(-1)!)
    const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void }
    child.pid = process.pid
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as never

  const runId = await detach(
    'review-lens',
    'resolved review role fixture',
    { cwd: import.meta.dir, lens: 'correctness' },
    'codex',
    spawnCoordinator,
  )

  expect(coordinatorSpec?.reviewRole).toBe('round')
  expect(db().query('SELECT review_role FROM run WHERE record_id=?').get(runId)).toEqual({
    review_role: 'round',
  })
})

test('a harness continuation placeholder carries its executor before coordinator claim', async () => {
  process.env.BOTTEGA_DEPTH = '0'
  const root = addRun({ agent: 'harness', job: 'review-lens', status: 'asking' })
  let placeholder: unknown
  const spawnCoordinator = (() => {
    placeholder = db()
      .query(
        `SELECT executor,evidence_excluded FROM run
          WHERE parent_run_record_id=? ORDER BY number DESC LIMIT 1`,
      )
      .get(root)
    const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void }
    child.pid = process.pid
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as never

  await detach(
    'review-lens',
    'harness continuation placeholder fixture',
    {
      cwd: import.meta.dir,
      lens: 'correctness',
      resume: {
        kind: 'continue',
        parent: root,
        agent: 'harness',
        turn: 2,
        sessionId: null,
        worktree: null,
      },
    },
    undefined,
    spawnCoordinator,
  )

  expect(placeholder).toEqual({
    executor: 'harness',
    evidence_excluded: 'harness execution',
  })
})

test('disposable-tree mutation: a registered project coordinator starts in the main checkout', () => {
  expect(spawnCwd('/repo/.claude/worktrees/live', '/repo', true, true, '/fallback')).toBe('/repo')
})

test('a post-insert launch failure marks the reserved row failed/harness', async () => {
  process.env.BOTTEGA_EXEC_PATH = `${dir}/missing-coordinator`
  process.env.BOTTEGA_DEPTH = '0'

  await expect(detach('summarize', 'detach handoff fixture', { cwd: dir })).rejects.toThrow()

  expect(
    db()
      .query(
        `SELECT record_id, status, failure_kind, error FROM run
         WHERE prompt_head='detach handoff fixture' ORDER BY number DESC LIMIT 1`,
      )
      .get(),
  ).toEqual({
    record_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/i),
    status: 'failed',
    failure_kind: 'harness',
    error: expect.stringContaining('detach handoff failed during await coordinator spawn'),
  })
})

test('a migration drain refuses dispatch before reserving a run', async () => {
  const before = (db().query('SELECT count(*) count FROM run').get() as { count: number }).count
  const refusalsBefore = db()
    .query<{ count: number }, []>(
      "SELECT count(*) count FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' AND event_kind='refusal'",
    )
    .get()!.count
  setMigrationDrain(db(), '0155_rebuild', 'draining', { pid: process.pid, startTime: null })
  try {
    await expect(detach('summarize', 'migration drain fixture', { cwd: dir })).rejects.toThrow(
      /refusing dispatch while draining for migration 0155_rebuild .*holder pid .*re-dispatch after .* machine update finishes/,
    )
    const after = (db().query('SELECT count(*) count FROM run').get() as { count: number }).count
    expect(after).toBe(before)
    expect(
      db()
        .query<{ count: number }, []>(
          "SELECT count(*) count FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' AND event_kind='refusal'",
        )
        .get()!.count,
    ).toBe(refusalsBefore + 1)
  } finally {
    clearMigrationDrain(db())
  }
})

test('a migrating marker that wins before the detached claim refuses without a run row', async () => {
  const prompt = 'migration drain claim race fixture'
  const refusalsBefore = db()
    .query<{ count: number }, []>(
      "SELECT count(*) count FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' AND event_kind='refusal'",
    )
    .get()!.count
  try {
    await expect(
      detach('summarize', prompt, { cwd: dir }, undefined, undefined, () => {
        setMigrationDrain(db(), '0155_rebuild', 'migrating', {
          pid: process.pid,
          startTime: null,
        })
      }),
    ).rejects.toThrow(/refusing dispatch while migrating for migration 0155_rebuild/)
    expect(db().query('SELECT record_id FROM run WHERE prompt_head=?').get(prompt)).toBeNull()
    expect(
      db()
        .query<{ count: number }, []>(
          "SELECT count(*) count FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' AND event_kind='refusal'",
        )
        .get()!.count,
    ).toBe(refusalsBefore + 1)
  } finally {
    clearMigrationDrain(db())
  }
})
