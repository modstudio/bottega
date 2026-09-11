import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, db, dir } from '../test/fixture.ts'
import { teardownTerminalRunResources } from './resource-ownership.ts'
import { runEventsPath } from './events.ts'

afterEach(() => { mock.restore() })

test('a live sibling in the same conversation prevents every terminal removal', () => {
  const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const failed = addRun({ agent: 'codex', job: 'implement', status: 'failed', parent, turn: 2 })
  db().query('UPDATE run SET worktree=? WHERE id IN (?,?)').run(dir, parent, failed)
  const removals: string[] = []
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result(`app-orch-${parent}-web`)
    if (command === 'docker volume ls --format {{.Name}}') return result('')
    if (command.startsWith('docker ')) removals.push(command)
    return command.startsWith('docker ') ? result('') : originalSpawnSync(args)
  }) as typeof Bun.spawnSync)
  const teardown = teardownTerminalRunResources(db(), failed)
  expect(removals).toEqual([])
  expect(teardown.outcome).toBe('live-sibling')
})

test('a live child hidden behind another conversation\'s collapsed ancestor blocks teardown', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const otherRoot = addRun({ agent: 'codex', job: 'implement', status: 'stopped' })
  const liveChild = addRun({
    agent: 'codex', job: 'implement', status: 'running', parent: otherRoot, turn: 2,
  })
  db().query('UPDATE run SET worktree=? WHERE id IN (?,?,?)')
    .run(dir, terminal, otherRoot, liveChild)
  const removals: string[] = []
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result(`app-orch-${terminal}-web`)
    if (command === 'docker volume ls --format {{.Name}}') return result('')
    if (command.startsWith('docker ')) {
      removals.push(command)
      return result('')
    }
    return originalSpawnSync(args)
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), terminal)

  expect(removals).toEqual([])
  expect(teardown.outcome).toBe('live-sibling')
})

test('a sibling appearing after inventory aborts removal under the cleanup lock', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-arriving-sibling-'))
  mkdirSync(join(tree, '.git'))
  db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, terminal)
  const removals: string[] = []
  let inserted = false
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result(`app-orch-${terminal}-web`)
    if (command === 'docker volume ls --format {{.Name}}') {
      const sibling = addRun({ agent: 'codex', job: 'implement', status: 'running' })
      db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, sibling)
      inserted = true
      return result('')
    }
    if (command.startsWith('docker ')) {
      removals.push(command)
      return result('')
    }
    if (command === 'git rev-parse --path-format=absolute --git-common-dir') {
      return result(join(tree, '.git'))
    }
    if (command === 'git rev-parse --git-common-dir') return result('.git')
    return originalSpawnSync(args)
  }) as typeof Bun.spawnSync)

  try {
    const teardown = teardownTerminalRunResources(db(), terminal)
    expect(inserted).toBe(true)
    expect(removals).toEqual([])
    expect(teardown.outcome).toBe('live-sibling')
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
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
  expect(teardown).toEqual(expect.objectContaining({
    outcome: 'unascertainable', reason: 'no recorded worktree', removed: 0, skipped: true,
  }))
})

test('physical path identity and a trailing separator reveal a live sharer', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const sibling = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const spelled = mkdtempSync(join(tmpdir(), 'orch-spelled-tree-'))
  const physical = realpathSync(spelled)
  mkdirSync(join(spelled, '.git'))
  db().query('UPDATE run SET worktree=? WHERE id=?').run(physical, terminal)
  db().query('UPDATE run SET worktree=? WHERE id=?').run(`${spelled}/`, sibling)
  const removals: string[] = []
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.startsWith('docker ')) removals.push(command)
    return command.startsWith('docker ') ? result('') : originalSpawnSync(args)
  }) as typeof Bun.spawnSync)
  try {
    const teardown = teardownTerminalRunResources(db(), terminal)
    expect(removals).toEqual([])
    expect(teardown).toEqual(expect.objectContaining({
      outcome: 'live-sibling', reason: 'live sharer present',
    }))
  } finally {
    rmSync(spelled, { recursive: true, force: true })
  }
})

test('an unresolvable repository root cannot ascertain removal', () => {
  const terminal = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  db().query('UPDATE run SET worktree=? WHERE id=?')
    .run(join(dir, 'absent-worktree'), terminal)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    commands.push(args.join(' '))
    return result('')
  }) as typeof Bun.spawnSync)

  const teardown = teardownTerminalRunResources(db(), terminal)

  expect(commands.some((command) => command.startsWith('docker '))).toBe(false)
  expect(teardown).toEqual(expect.objectContaining({
    outcome: 'unascertainable', reason: 'unresolvable repository root', removed: 0,
  }))
})

test('a removal timeout is recorded in the durable run event log', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const tree = mkdtempSync(join(tmpdir(), 'orch-timeout-tree-'))
  mkdirSync(join(tree, '.git'))
  db().query('UPDATE run SET worktree=? WHERE id=?').run(tree, id)
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command === 'docker ps -a --format {{.Names}}') return result(`app-orch-${id}-web`)
    if (command === 'docker volume ls --format {{.Name}}') return result('')
    if (command.startsWith('docker ')) return { ...result(''), exitedDueToTimeout: true }
    if (command === 'git rev-parse --path-format=absolute --git-common-dir') {
      return result(join(tree, '.git'))
    }
    if (command === 'git rev-parse --git-common-dir') return result('.git')
    return originalSpawnSync(args)
  }) as typeof Bun.spawnSync)
  try {
    teardownTerminalRunResources(db(), id)
    expect(readFileSync(runEventsPath(id), 'utf8')).toContain('Docker teardown incomplete')
    expect(readFileSync(runEventsPath(id), 'utf8')).toContain('timed out after 10000ms')
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr),
    success: exitCode === 0, exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
