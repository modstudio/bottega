import { expect, spyOn, test } from 'bun:test'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, createWorktree, db, fakeDocker, nowIso, upsertProject, worktreeDescribeFixture } from '../test/fixture.ts'
import { sweepRuns } from './cleanup-sweep.ts'

const { git, scratchRepo } = worktreeDescribeFixture()

test('sweep keeps a cut commit after trunk is rewound away from it', async () => {
  const { repo } = scratchRepo()
  const project = `rewound-cut-sweep-${repo.split('/').pop()}`
  writeFileSync(join(repo, 'cut.txt'), 'recorded cut\n')
  git(repo, 'add', 'cut.txt'); git(repo, 'commit', '-m', 'recorded cut')
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  const tree = createWorktree(repo, id)
  const tip = git(repo, 'rev-parse', tree.branch)
  git(repo, 'worktree', 'remove', '--force', tree.path)
  expect(existsSync(tree.path)).toBe(false)
  git(repo, 'reset', '--hard', 'HEAD~1')
  upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main' } })
  db().query(
    `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, head_commit=?,
                    started_at=?, worktree_source='git' WHERE id=?`,
  ).run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tip, tip,
    '2020-01-01T00:00:00.000Z', id)
  db().query(
    `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
     VALUES (?,'full','right','faithful',?)`,
  ).run(id, nowIso())
  const errors: string[] = []
  const presentation = {
    log: (..._values: unknown[]) => {}, error: (...values: unknown[]) => { errors.push(values.join(' ')) },
    setExitCode: (_code: number) => {}, keptBranchLine: (branch: string) => `kept branch ${branch}`,
  }
  const docker = fakeDocker([], [])
  const originalSpawn = Bun.spawnSync
  const spawned = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[], options: any) =>
    cmd[0] === 'docker'
      ? originalSpawn([join(docker.dir, 'docker'), ...cmd.slice(1)], {
          ...options, env: { ...process.env, ...docker.env },
        })
      : originalSpawn(cmd, options)) as typeof Bun.spawnSync)
  try {
    await sweepRuns({ dryRun: false, force: false, presentation }, {
      grokTrustHeadings: () => [], grokTrustPathFromHeading: () => null,
    })
    expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
    expect(errors).toEqual([])
    expect(db().query(
      'SELECT worktree, branch, branch_kept, branch_kept_tip, head_commit FROM run WHERE id=?',
    ).get(id)).toEqual({
      worktree: tree.path, branch: tree.branch, branch_kept: tree.branch,
      branch_kept_tip: tip, head_commit: tip,
    })
  } finally {
    spawned.mockRestore()
    rmSync(docker.dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})
