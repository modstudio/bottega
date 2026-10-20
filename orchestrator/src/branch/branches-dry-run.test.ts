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
import { pruneBranches, renderBranchPruneReport } from './branches.ts'

test('dry-run previews automatic landing repair without writing', () => {
  const repository = gitRepository('automatic-repair-preview')
  const bin = mkdtempSync(join(tmpdir(), 'orch-automatic-repair-preview-bin-'))
  const originalPath = process.env.PATH
  const project = 'automatic-repair-preview'
  const key = 'DEV-1049'
  const branch = `${key}-orch-preview`
  try {
    git(repository, 'remote', 'add', 'origin', repository)
    git(repository, 'checkout', '-b', branch)
    writeFileSync(join(repository, 'state.txt'), 'branch work\n')
    git(repository, 'commit', '-am', `${key} branch work`)
    const tip = git(repository, 'rev-parse', 'HEAD')
    git(repository, 'checkout', 'main')
    const projectId = addProject(project, repository)
    const runId = addRun({ agent: 'codex', job: 'automatic landing preview', repo: project })
    db()
      .query(
        'UPDATE run SET project_record_id=?,launch_key=?,branch=?,minted_branch=? WHERE record_id=?',
      )
      .run(projectId, key, branch, branch, runId)
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' '[{"number":1049,"state":"MERGED","headRefName":"${branch}","headRefOid":"${tip}","title":"${key} merged","mergeCommit":{"oid":"merge1049"},"mergedAt":"2026-09-30T12:00:00Z"}]'\n`,
    )
    chmodSync(join(bin, 'gh'), 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ''}`

    const dryRun = pruneBranches({ project, key, dryRun: true })
    expect(dryRun.recordedLandings).toEqual([])
    expect(dryRun.wouldRecordLandings.map((landing) => landing.branch)).toEqual([branch])
    expect(renderBranchPruneReport(dryRun)).toContain(`would record landing: ${branch} (PR #1049)`)
    expect(
      db().query('SELECT COUNT(*) count FROM branch_landing_record').get() as { count: number },
    ).toEqual({ count: 0 })
    expect(git(repository, 'show-ref', '--verify', `refs/heads/${branch}`)).toContain(tip)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(bin, { recursive: true, force: true })
    removeGitRepository(repository)
  }
})
