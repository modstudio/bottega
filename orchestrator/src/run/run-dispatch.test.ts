import { afterEach, expect, test } from 'bun:test'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { detach, spawnCwd } from './run-dispatch.ts'

const originalExecPath = process.env.ORCH_EXEC_PATH
const originalDepth = process.env.ORCH_DEPTH
afterEach(() => {
  if (originalExecPath === undefined) delete process.env.ORCH_EXEC_PATH
  else process.env.ORCH_EXEC_PATH = originalExecPath
  if (originalDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = originalDepth
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
