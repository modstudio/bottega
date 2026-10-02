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
import { recordBranchLanding } from './branch-landing-service.ts'
import { pruneBranches, renderBranchPruneReport } from './branches.ts'

test('landing refusal explains that only a run-minted branch can be recorded', () => {
  expect(() => recordBranchLanding('DEV-1070-shipping', 1070)).toThrow(
    "branch DEV-1070-shipping is not a recorded run branch; there is nothing to record for a branch no run minted; name a run's own branch instead",
  )
})

test('dry-run previews automatic landing repair without writing, then non-dry prune records it', () => {
  const repository = gitRepository('automatic-repair')
  const bin = mkdtempSync(join(tmpdir(), 'orch-automatic-repair-bin-'))
  const originalPath = process.env.PATH
  const project = 'automatic-repair'
  const key = 'DEV-1049'
  const branch = `${key}-orch-test`
  try {
    git(repository, 'remote', 'add', 'origin', repository)
    git(repository, 'checkout', '-b', branch)
    writeFileSync(join(repository, 'state.txt'), 'branch work\n')
    git(repository, 'commit', '-am', `${key} branch work`)
    const tip = git(repository, 'rev-parse', 'HEAD')
    git(repository, 'checkout', 'main')

    addProject(project, repository)
    const runId = addRun({ agent: 'codex', job: 'automatic landing repair', repo: project })
    db()
      .query('UPDATE run SET launch_key=?,branch=?,minted_branch=? WHERE id=?')
      .run(key, branch, branch, runId)

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

    const persisted = pruneBranches({ project, key })
    expect(persisted.recordedLandings.map((landing) => landing.branch)).toEqual([branch])
    expect(persisted.wouldRecordLandings).toEqual([])
    expect(
      db().query('SELECT branch,tip,pr_number FROM branch_landing_record').get() as {
        branch: string
        tip: string
        pr_number: number
      },
    ).toEqual({ branch, tip, pr_number: 1049 })
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(bin, { recursive: true, force: true })
    removeGitRepository(repository)
  }
})
