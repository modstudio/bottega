import { spyOn } from 'bun:test'
import { appendFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { upsertProject } from '../project/projects.ts'

function spawnResult(): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

export function commit(cwd: string, message: string): void {
  git(['add', '-A'], cwd)
  git(
    ['-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid', 'commit', '-m', message],
    cwd,
  )
}

export function closeOutFixture(
  options: { submodule?: boolean; carryBase?: boolean; trackedDirectory?: boolean } = {},
) {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'ok' })
  const project = `reader-nested-close-out-${id}`
  const fixtureRoot = realpathSync(dir)
  const repo = join(fixtureRoot, project)
  const nestedSource = join(fixtureRoot, `${project}-nested`)

  mkdirSync(repo, { recursive: true })
  git(['init', '--initial-branch=main'], repo)
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
  if (options.trackedDirectory) {
    mkdirSync(join(repo, 'tracked-directory'), { recursive: true })
    writeFileSync(join(repo, 'tracked-directory', 'tracked.txt'), 'committed nested\n')
  }
  if (options.submodule) {
    mkdirSync(nestedSource, { recursive: true })
    git(['init', '--initial-branch=main'], nestedSource)
    writeFileSync(join(nestedSource, 'nested.txt'), 'committed\n')
    commit(nestedSource, 'nested initial')
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', nestedSource, 'nested'], repo)
  }
  commit(repo, 'main initial')
  const base = git(['rev-parse', 'HEAD'], repo)
  if (options.carryBase) {
    writeFileSync(join(repo, 'review-tip.txt'), 'review tip\n')
    commit(repo, 'review tip')
  }
  const head = git(['rev-parse', 'HEAD'], repo)
  const worktree = join(repo, '.claude', 'worktrees', `orch-${id}`)
  mkdirSync(dirname(worktree), { recursive: true })
  git(
    [
      '-c',
      'protocol.file.allow=always',
      'clone',
      '--shared',
      ...(options.submodule ? ['--recurse-submodules'] : []),
      repo,
      worktree,
    ],
    repo,
  )
  git(['checkout', '--detach', head], worktree)
  upsertProject({ recordId: newRecordId(), name: project, path: repo, settings: { trunk: 'main' } })
  db()
    .query(
      `UPDATE run SET repo=?,cwd=?,worktree=?,branch=NULL,minted_branch=NULL,base_commit=?,
       carry_base_commit=?,worktree_source='clone',head_commit=? WHERE record_id=?`,
    )
    .run(project, worktree, worktree, base, options.carryBase ? head : null, head, id)
  writeFileSync(join(worktree, '.orch-run'), `${id}\n${repo}\nsource: clone\n`)
  appendFileSync(join(worktree, '.git', 'info', 'exclude'), '.orch-run\n')
  const realSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[], spawnOptions?: object) =>
    command[0] === 'ps'
      ? spawnResult()
      : realSpawnSync(command, spawnOptions)) as typeof Bun.spawnSync)

  return { id, repo, nestedSource, worktree }
}

export function cleanFixture(repo: string, nestedSource: string): void {
  rmSync(repo, { recursive: true, force: true })
  rmSync(nestedSource, { recursive: true, force: true })
  rmSync(join(dirname(repo), 'archive'), { recursive: true, force: true })
}

export function archivedClonePath(detail: string): string {
  const marker = 'whole reader clone archived at '
  const offset = detail.indexOf(marker)
  if (offset < 0) throw new Error(`close-out detail did not name the reader archive: ${detail}`)
  return detail
    .slice(offset + marker.length)
    .split(';')[0]!
    .trim()
}
