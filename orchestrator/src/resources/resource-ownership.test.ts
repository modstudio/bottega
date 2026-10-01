import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  teardownTerminalRunResources,
  terminalDockerRetentionReasonForRun,
} from './resource-ownership.ts'

afterEach(() => {
  mock.restore()
})

test('a terminal child leaves its live conversation resource untouched', () => {
  const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const failed = addRun({ agent: 'codex', job: 'implement', status: 'failed', parent, turn: 2 })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(dir, parent)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a')) return result(`app-orch-${parent}-web`)
    if (command.startsWith('docker volume ls')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return result('')
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), failed)

  expect(commands).not.toContain(`docker rm -f app-orch-${parent}-web`)
  expect(teardown).toEqual(
    expect.objectContaining({
      outcome: 'live-sibling',
      reason: 'live sharer present',
      removed: 0,
      skipped: true,
    }),
  )
})

test('a terminal transition without a recorded worktree skips Docker inventory', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a')) return result(`app-orch-${terminal}-web`)
    if (command.startsWith('docker volume ls')) return result(`app_orch-${terminal}_data`)
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return result('')
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), terminal)

  expect(commands).toEqual([])
  expect(teardown).toEqual(expect.objectContaining({ outcome: 'nothing', removed: 0 }))
})

test('a supplied sweep inventory reclaims resources whose run no longer records a worktree', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), terminal, {
    ascertainable: true,
    resources: [
      { kind: 'container', name: `app-orch-${terminal}-web`, runId: terminal },
      { kind: 'volume', name: `app_orch-${terminal}_data`, runId: terminal },
    ],
  })

  expect(commands).toContain(`docker rm -f app-orch-${terminal}-web`)
  expect(commands).toContain(`docker volume rm app_orch-${terminal}_data`)
  expect(teardown).toEqual(expect.objectContaining({ outcome: 'removed', removed: 2 }))
})

test('a dry-run applies terminal teardown eligibility without mutating Docker', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)

  const preview = teardownTerminalRunResources(
    db(),
    terminal,
    {
      ascertainable: true,
      resources: [
        { kind: 'container', name: `app-orch-${terminal}-web`, runId: terminal },
        { kind: 'volume', name: `app_orch-${terminal}_data`, runId: terminal },
      ],
    },
    { dryRun: true },
  )

  expect(commands).toEqual([])
  expect(preview).toEqual(
    expect.objectContaining({ outcome: 'removed', removed: 2, skipped: false }),
  )
})

test('a dry-run retains a main-checkout resource just like the real path', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const preview = teardownTerminalRunResources(
    db(),
    terminal,
    {
      ascertainable: true,
      resources: [
        {
          kind: 'volume',
          name: 'main_database',
          runId: terminal,
          mainCheckout: true,
        },
      ],
    },
    { dryRun: true },
  )

  expect(preview).toEqual(
    expect.objectContaining({ outcome: 'unascertainable', removed: 0, skipped: true }),
  )
})

test('an absent unregistered tree with no resources is already clean', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(join(dir, 'absent-worktree'), terminal)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), terminal)

  expect(commands.some((command) => command.startsWith('docker '))).toBe(true)
  expect(teardown).toEqual(
    expect.objectContaining({
      outcome: 'nothing',
      reason: null,
      removed: 0,
    }),
  )
})

test('a registered project root resolves safety after the worktree is gone', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const project = `registered-root-${terminal}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${terminal}`)
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  db()
    .query('UPDATE run SET repo=?,cwd=?,worktree=? WHERE id=?')
    .run(project, join(dir, 'also-gone'), tree, terminal)

  expect(terminalDockerRetentionReasonForRun(db(), terminal)).toBeNull()
})

test('stopped runs with gone trees treat disposable infrastructure as ordinary cleanup', () => {
  const stopped = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  db().query('UPDATE run SET worktree=? WHERE id=?').run(join(dir, 'gone-worktree'), stopped)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)
  const teardown = teardownTerminalRunResources(db(), stopped)
  expect(commands.some((command) => command.startsWith('docker '))).toBe(true)
  expect(teardown).toEqual(
    expect.objectContaining({
      outcome: 'nothing',
      reason: null,
      removed: 0,
      skipped: false,
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
