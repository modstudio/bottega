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
import {
  recordAutomaticBranchLandingEvidence,
  recordBranchLanding,
} from './branch-landing-service.ts'
import { pruneBranch, pruneBranches, renderBranchPruneReport } from './branches.ts'

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

    const projectId = addProject(project, repository)
    const runId = addRun({ agent: 'codex', job: 'automatic landing repair', repo: project })
    db()
      .query('UPDATE run SET project_record_id=?,launch_key=?,branch=?,minted_branch=? WHERE id=?')
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

    const sibling = `${key}-sibling`
    git(repository, 'checkout', '-b', sibling)
    writeFileSync(join(repository, 'state.txt'), 'sibling work\n')
    git(repository, 'commit', '-am', `${key} sibling work`)
    git(repository, 'checkout', 'main')
    const siblingRun = addRun({ agent: 'codex', job: 'sibling branch', repo: project })
    db()
      .query('UPDATE run SET project_record_id=?,launch_key=?,branch=?,minted_branch=? WHERE id=?')
      .run(projectId, key, sibling, sibling, siblingRun)

    const persisted = pruneBranch({ project, branch })
    expect(persisted.recordedLandings.map((landing) => landing.branch)).toEqual([branch])
    expect(persisted.wouldRecordLandings).toEqual([])
    expect(git(repository, 'show-ref', '--verify', `refs/heads/${sibling}`)).toContain(sibling)
    const first = db()
      .query('SELECT record_id,branch,tip,pr_number FROM branch_landing_record')
      .get() as {
      record_id: string
      branch: string
      tip: string
      pr_number: number
    }
    expect(first).toEqual({ record_id: expect.any(String), branch, tip, pr_number: 1049 })

    recordAutomaticBranchLandingEvidence(branch, {
      number: 1050,
      state: 'MERGED',
      headRefName: branch,
      headRefOid: 'updated-tip',
      title: `${key} updated landing`,
      mergeCommit: { oid: 'updated-merge' },
      mergedAt: '2026-10-01T12:00:00Z',
    })
    expect(
      db()
        .query(
          `SELECT record_id,branch,tip,pr_number,merge_commit,merged_at
             FROM branch_landing_record`,
        )
        .get() as {
        record_id: string
        branch: string
        tip: string
        pr_number: number
        merge_commit: string
        merged_at: string
      },
    ).toEqual({
      record_id: first.record_id,
      branch,
      tip: 'updated-tip',
      pr_number: 1050,
      merge_commit: 'updated-merge',
      merged_at: '2026-10-01T12:00:00Z',
    })
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(bin, { recursive: true, force: true })
    removeGitRepository(repository)
  }
})
