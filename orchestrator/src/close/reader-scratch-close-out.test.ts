import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'
import { createReadOnlyWorktree } from '../worktree/worktree-readonly.ts'
import { closeOutRun } from './close-out.ts'

afterEach(() => {
  mock.restore()
})

function spawnResult(): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

test('reader close-out holds a clone whose submodule has tracked and untracked scratch', () => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'ok' })
  const project = `reader-submodule-close-out-${id}`
  const fixtureRoot = realpathSync(dir)
  const repo = join(fixtureRoot, project)
  const nestedSource = join(fixtureRoot, `${project}-nested`)
  const commit = (cwd: string, message: string) =>
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '-m',
        message,
      ],
      cwd,
    )

  mkdirSync(repo, { recursive: true })
  mkdirSync(nestedSource, { recursive: true })
  try {
    git(['init', '--initial-branch=main'], nestedSource)
    writeFileSync(join(nestedSource, 'tracked.txt'), 'committed\n')
    git(['add', 'tracked.txt'], nestedSource)
    commit(nestedSource, 'nested initial')

    git(['init', '--initial-branch=main'], repo)
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', nestedSource, 'nested'], repo)
    commit(repo, 'main initial')
    const head = git(['rev-parse', 'HEAD'], repo)
    upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
    const worktree = createReadOnlyWorktree(repo, id, head)
    git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'],
      worktree.path,
    )
    const nested = join(worktree.path, 'nested')
    writeFileSync(join(nested, 'tracked.txt'), 'modified\n')
    writeFileSync(join(nested, 'untracked.txt'), 'scratch\n')
    db()
      .query(
        `UPDATE run SET repo=?,cwd=?,worktree=?,branch=NULL,minted_branch=NULL,base_commit=?,
         worktree_source='clone',head_commit=? WHERE id=?`,
      )
      .run(project, worktree.path, worktree.path, head, head, id)
    const realSpawnSync = Bun.spawnSync
    spyOn(Bun, 'spawnSync').mockImplementation(((command: string[], options?: object) =>
      command[0] === 'ps'
        ? spawnResult()
        : realSpawnSync(command, options)) as typeof Bun.spawnSync)

    const result = closeOutRun(id, { intent: 'terminal' })

    expect(result).toMatchObject({ outcome: 'held' })
    expect(result.detail).toContain('dirty nested repositories: nested')
    expect(result.detail).toContain('preserve and clean their changes, then retry close-out')
    expect(existsSync(worktree.path)).toBe(true)
    expect(readFileSync(join(nested, 'tracked.txt'), 'utf8')).toBe('modified\n')
    expect(readFileSync(join(nested, 'untracked.txt'), 'utf8')).toBe('scratch\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(nestedSource, { recursive: true, force: true })
  }
})
