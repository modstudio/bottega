import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { teardownTerminalRunResources } from './resource-ownership.ts'

afterEach(() => {
  mock.restore()
})

test('a failed resume child with no recorded worktree cannot ascertain removal', () => {
  const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const failed = addRun({ agent: 'codex', job: 'implement', status: 'failed', parent, turn: 2 })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(dir, parent)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result(`app-orch-${parent}-web`)
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), failed)

  expect(commands).toEqual([])
  expect(teardown).toEqual(
    expect.objectContaining({
      outcome: 'unascertainable',
      reason: 'no recorded worktree',
      removed: 0,
      skipped: true,
    }),
  )
})

test('an unresolvable repository root cannot ascertain removal', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(join(dir, 'absent-worktree'), terminal)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), terminal)

  expect(commands.some((command) => command.startsWith('docker '))).toBe(false)
  expect(teardown).toEqual(
    expect.objectContaining({
      outcome: 'unascertainable',
      reason: 'unresolvable repository root',
      removed: 0,
    }),
  )
})

test('stopped runs with gone trees retain surviving infrastructure for review', () => {
  const stopped = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(join(dir, 'gone-worktree'), stopped)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)
  const teardown = teardownTerminalRunResources(db(), stopped)
  expect(commands.some((command) => command.startsWith('docker '))).toBe(false)
  expect(teardown).toEqual(
    expect.objectContaining({
      outcome: 'unascertainable',
      reason: 'unresolvable repository root',
      removed: 0,
      skipped: true,
    }),
  )
})

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
