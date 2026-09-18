import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { terminalCloseOutRuns } from '../monitor/monitor-conditions.ts'
import { upsertProject } from '../project/projects.ts'
import { type CleanupPresentation, type CleanupRow, discardWorktree } from './cleanup.ts'

afterEach(() => {
  mock.restore()
})

function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

const presentation = (): CleanupPresentation => ({
  log: () => {},
  error: () => {},
  setExitCode: () => {},
  keptBranchLine: (branch) => `kept branch ${branch}`,
})

function heldCleanup(id: number): { project: string; repo: string; tree: string; row: CleanupRow } {
  const project = `cleanup-held-${id}`
  const repo = join(dir, project)
  const tree = join(repo, '.claude', 'worktrees', `orch-${id}`)
  mkdirSync(join(repo, '.git'), { recursive: true })
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  db()
    .query(
      `UPDATE run
       SET repo=?, cwd=?, worktree=?, worktree_source='git',
           close_out_outcome='held', close_out_detail=?, close_out_attempted_at=?
       WHERE id=?`,
    )
    .run(project, tree, tree, 'close-out held the tree', '2026-09-18T00:00:00.000Z', id)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    const args = command[0] === 'git' ? command.slice(1) : command
    if (args.includes('--git-common-dir')) return spawnResult('.git')
    return spawnResult()
  }) as typeof Bun.spawnSync)
  return {
    project,
    repo,
    tree,
    row: {
      id,
      repo: project,
      cwd: tree,
      worktree: tree,
      branch: null,
      base_commit: null,
      worktree_source: 'git',
    },
  }
}

function discard(row: CleanupRow): void {
  discardWorktree(row, 'discarded', false, undefined, {
    force: false,
    auditReason: null,
    presentation: presentation(),
  })
}

function closeOutIds(): number[] {
  return terminalCloseOutRuns().map((run) => run.id)
}

test('a run held at close-out, then discarded, is no longer returned by terminalCloseOutRuns', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const fixture = heldCleanup(id)
  try {
    expect(closeOutIds()).toContain(id)

    discard(fixture.row)

    expect(closeOutIds()).not.toContain(id)
    expect(
      db()
        .query(
          'SELECT worktree, close_out_outcome, close_out_detail, close_out_attempted_at FROM run WHERE id=?',
        )
        .get(id),
    ).toEqual({
      worktree: null,
      close_out_outcome: null,
      close_out_detail: null,
      close_out_attempted_at: null,
    })
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})

test('releasing a shared worktree pointer drops this run from terminalCloseOutRuns and leaves the other conversation held', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const other = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const fixture = heldCleanup(id)
  try {
    db()
      .query(
        `UPDATE run
         SET repo=?, cwd=?, worktree=?, worktree_source='git',
             close_out_outcome='held', close_out_detail=?, close_out_attempted_at=?
         WHERE id=?`,
      )
      .run(
        fixture.project,
        fixture.tree,
        fixture.tree,
        'close-out held the shared tree',
        '2026-09-18T00:00:00.000Z',
        other,
      )
    expect(closeOutIds()).toEqual(expect.arrayContaining([id, other]))

    expect(() => discard(fixture.row)).toThrow(/still claimed by other conversations/)

    expect(closeOutIds()).toEqual([other])
    expect(
      db()
        .query(
          'SELECT worktree, close_out_outcome, close_out_detail, close_out_attempted_at FROM run WHERE id=?',
        )
        .get(id),
    ).toEqual({
      worktree: null,
      close_out_outcome: null,
      close_out_detail: null,
      close_out_attempted_at: null,
    })
    expect(
      db()
        .query(
          'SELECT worktree, close_out_outcome, close_out_detail, close_out_attempted_at FROM run WHERE id=?',
        )
        .get(other),
    ).toEqual({
      worktree: fixture.tree,
      close_out_outcome: 'held',
      close_out_detail: 'close-out held the shared tree',
      close_out_attempted_at: '2026-09-18T00:00:00.000Z',
    })
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true })
  }
})
