import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { sweepRuns } from './cleanup-sweep.ts'

afterEach(() => {
  mock.restore()
})

test('a live run-named directory with unknown root project ownership is kept and reported', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-sweep-unknown-owner-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const name = `sweep-unknown-owner-${run}`
  const tree = join(projectPath, '.claude', 'worktrees', `orch-${run}`)
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), 'gitdir: unavailable\n')
  const runRecordId = db()
    .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
    .get(run)!.record_id
  writeFileSync(join(tree, '.orch-run'), `${runRecordId}\n${projectPath}\nsource: git\n`)
  upsertProject({
    recordId: newRecordId(),
    name,
    path: projectPath,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  db().query('UPDATE run SET repo=?,cwd=?,project_record_id=NULL WHERE id=?').run(name, tree, run)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options) => {
    const command = args.join(' ')
    if (command.startsWith('docker ps -a --format')) return result('')
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)
  const lines: string[] = []
  let exitCode = 0

  try {
    await sweepRuns(
      {
        dryRun: false,
        project: name,
        force: false,
        presentation: presentation(lines, (code) => {
          exitCode = code
        }),
      },
      {
        observeGrokTrustHeadings: () => ({ succeeded: true, headings: [] }),
        grokTrustPathFromHeading: () => null,
      },
    )

    expect(existsSync(tree)).toBeTrue()
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toContain(
      `could not reclaim orphan  ${tree}: conversation root ${run} project UUID is missing; members ${run}=missing`,
    )
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('an orphan directory with a conflicting conversation member is kept and reported', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-sweep-conflicting-owner-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  const name = `sweep-conflicting-owner-${root}`
  const projectRecordId = newRecordId()
  const conflictingRecordId = newRecordId()
  const tree = join(projectPath, '.claude', 'worktrees', `orch-${root}`)
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), 'gitdir: unavailable\n')
  const rootRecordId = db()
    .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
    .get(root)!.record_id
  writeFileSync(join(tree, '.orch-run'), `${rootRecordId}\n${projectPath}\nsource: git\n`)
  upsertProject({
    recordId: projectRecordId,
    name,
    path: projectPath,
    settings: {
      trunk: 'main',
      worktree: { branch: 'orch-{id}', remove: 'registered-remove-marker {path}' },
    },
  })
  upsertProject({
    recordId: conflictingRecordId,
    name: `${name}-conflict`,
    path: join(projectPath, 'conflict'),
    settings: {},
  })
  db()
    .query('UPDATE run SET repo=?,project_record_id=? WHERE id=?')
    .run(name, projectRecordId, root)
  db()
    .query('UPDATE run SET repo=?,project_record_id=? WHERE id=?')
    .run(name, conflictingRecordId, child)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a --format')) return result('')
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)
  const lines: string[] = []
  let exitCode = 0

  try {
    await sweepRuns(
      {
        dryRun: false,
        project: name,
        force: false,
        presentation: presentation(lines, (code) => {
          exitCode = code
        }),
      },
      {
        observeGrokTrustHeadings: () => ({ succeeded: true, headings: [] }),
        grokTrustPathFromHeading: () => null,
      },
    )

    expect(existsSync(tree)).toBeTrue()
    expect(commands.some((command) => command.includes('registered-remove-marker'))).toBeFalse()
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toContain(
      `run ${child} project UUID ${conflictingRecordId} conflicts with root ${root} project UUID ${projectRecordId}`,
    )
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('a NULL-root chain with a UUID child removes neither its tree nor Docker resources', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-sweep-null-root-chain-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const root = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    parent: root,
    turn: 2,
  })
  const name = `sweep-null-root-chain-${root}`
  const recordId = newRecordId()
  const tree = join(projectPath, '.claude', 'worktrees', `orch-${root}`)
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, '.git'), 'gitdir: unavailable\n')
  upsertProject({
    recordId,
    name,
    path: projectPath,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  db()
    .query('UPDATE run SET repo=?,cwd=?,worktree=?,project_record_id=NULL WHERE id=?')
    .run(name, tree, tree, root)
  db().query('UPDATE run SET repo=?,project_record_id=? WHERE id=?').run(name, recordId, child)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options) => {
    const command = args.join(' ')
    commands.push(command)
    if (command.startsWith('docker ps -a --format')) return result(`app-orch-${child}-web`)
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)
  const lines: string[] = []
  let exitCode = 0

  try {
    await sweepRuns(
      {
        dryRun: false,
        project: name,
        force: false,
        presentation: presentation(lines, (code) => {
          exitCode = code
        }),
      },
      {
        observeGrokTrustHeadings: () => ({ succeeded: true, headings: [] }),
        grokTrustPathFromHeading: () => null,
      },
    )

    expect(existsSync(tree)).toBeTrue()
    expect(commands.some((command) => command.startsWith('docker rm'))).toBeFalse()
    expect(exitCode).toBe(1)
    expect(lines.join('\n')).toContain(`conversation root ${root} project UUID is missing`)
    expect(lines.join('\n')).toContain(`members ${root}=missing, ${child}=${recordId}`)
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

function presentation(lines: string[], setExitCode: (code: number) => void): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    setExitCode,
    keptBranchLine: () => '',
  }
}

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
