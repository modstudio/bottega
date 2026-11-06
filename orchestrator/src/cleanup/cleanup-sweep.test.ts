import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('an owned terminal sweep candidate reaches close-out by UUID', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-sweep-owned-terminal-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const projectRecordId = newRecordId()
  const name = `sweep-owned-terminal-${projectRecordId}`
  upsertProject({
    recordId: projectRecordId,
    name,
    path: projectPath,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const tree = join(projectPath, '.claude', 'worktrees', `orch-${run}`)
  db()
    .query('UPDATE run SET repo=?,project_record_id=?,worktree=?,cwd=? WHERE record_id=?')
    .run(name, projectRecordId, tree, tree, run)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options) => {
    const command = args.join(' ')
    if (command === 'docker ps --format {{.Label "com.docker.compose.project.working_dir"}}')
      return result('')
    if (command.startsWith('docker ps -a --format')) return result('')
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)

  try {
    const lines: string[] = []
    await sweepRuns(
      {
        dryRun: false,
        project: name,
        force: false,
        presentation: presentation(lines, () => {}),
      },
      {
        observeGrokTrustHeadings: () => ({ succeeded: true, headings: [] }),
        grokTrustPathFromHeading: () => null,
        hubTaskReader: async () => [],
        outboxMaintenance: {
          drain: () => {
            throw new Error('prune busy')
          },
          release: () => {
            throw new Error('release busy')
          },
          releasePages: () => {
            throw new Error('vacuum busy')
          },
        },
        telemetryMaintenance: {
          rollupContention: () => {
            throw new Error('rollup busy')
          },
          pruneContention: () => {
            throw new Error('contention prune busy')
          },
          pruneMonitor: () => {
            throw new Error('monitor prune busy')
          },
        },
      },
    )
    expect(db().query('SELECT close_out_outcome FROM run WHERE record_id=?').get(run)).toEqual({
      close_out_outcome: 'absent',
    })
    expect(lines).toContain('outbox prune failed: prune busy')
    expect(lines).toContain('outbox release failed: release busy')
    expect(lines).toContain('contention rollup failed: rollup busy')
    expect(lines).toContain('contention prune failed: contention prune busy')
    expect(lines).toContain('monitor prune failed: monitor prune busy')
    expect(lines).toContain('outbox space release failed: vacuum busy')
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
