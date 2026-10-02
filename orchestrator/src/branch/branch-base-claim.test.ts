import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addProject,
  git,
  gitRepository,
  removeGitRepository,
} from '../../test/fixtures/offline-branch-landing.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { pruneBranches } from './branches.ts'

test('prune keeps a superseded branch used by an asking chain, then deletes it when finished', () => {
  const repository = gitRepository('live-base-claim')
  const bin = mkdtempSync(join(tmpdir(), 'orch-live-base-claim-bin-'))
  const originalPath = process.env.PATH
  const project = 'live-base-claim'
  const key = 'DEV-1071'
  const branch = `${key}-orch-old`
  try {
    git(repository, 'remote', 'add', 'origin', repository)
    git(repository, 'checkout', '-b', branch)
    writeFileSync(join(repository, 'state.txt'), 'branch work\n')
    git(repository, 'commit', '-am', `${key} branch work`)
    git(repository, 'checkout', 'main')

    const projectId = addProject(project, repository)
    const old = addRun({ agent: 'codex', job: 'implement', repo: project, status: 'ok' })
    db()
      .query('UPDATE run SET project_id=?,launch_key=?,branch=?,minted_branch=? WHERE id=?')
      .run(projectId, key, branch, branch, old)
    const replacement = addRun({
      agent: 'codex',
      job: 'implement',
      repo: project,
      status: 'ok',
    })
    db()
      .query('UPDATE run SET project_id=?,launch_key=?,launch_base=?,branch=? WHERE id=?')
      .run(projectId, key, 'main', `${key}-orch-new`, replacement)
    const holder = addRun({
      agent: 'codex',
      job: 'implement',
      repo: project,
      status: 'asking',
    })
    db()
      .query('UPDATE run SET project_id=?,launch_base=? WHERE id=?')
      .run(projectId, branch, holder)

    writeFileSync(join(bin, 'gh'), "#!/bin/sh\nprintf '%s\\n' '[]'\n")
    chmodSync(join(bin, 'gh'), 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const kept = pruneBranches({ project, key })
    expect(kept.kept).toContainEqual({
      branch,
      reason: `base of live run ${holder} (asking)`,
    })
    expect(git(repository, 'show-ref', '--verify', `refs/heads/${branch}`)).not.toBe('')

    db().query("UPDATE run SET status='ok' WHERE id=?").run(holder)
    const pruned = pruneBranches({ project, key })
    expect(pruned.deleted).toContain(branch)
    expect(() => git(repository, 'show-ref', '--verify', `refs/heads/${branch}`)).toThrow()
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(bin, { recursive: true, force: true })
    removeGitRepository(repository)
  }
})
