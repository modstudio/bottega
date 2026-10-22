import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { branchesReport } from '../branch/branches.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  decideBranchReclaimEvidence,
  reclaimBranch,
  reclaimBranchesDryRun,
  reclaimWorktree,
} from './reclaim.ts'

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

test('reclaim locked recheck preserves a worktree when a terminal sharer appears after preflight', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-terminal-reclaim-'))
  const tree = join(root, '.claude', 'worktrees', 'shared')
  git(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'README.md'), 'fixture\n')
  git(root, ['add', 'README.md'])
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  ])
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true })
  git(root, ['worktree', 'add', '--quiet', '-b', 'shared-reclaim', tree])

  const project = `shared-reclaim-${newRecordId()}`
  const projectRecordId = newRecordId()
  upsertProject({
    recordId: projectRecordId,
    name: project,
    path: root,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  const first = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  const second = addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project })
  db()
    .query('UPDATE run SET project_record_id=?,worktree=? WHERE record_id=?')
    .run(projectRecordId, tree, first)

  try {
    const result = reclaimWorktree(tree, {
      beforeLockedProof: () => {
        db()
          .query('UPDATE run SET project_record_id=?,worktree=? WHERE record_id=?')
          .run(projectRecordId, tree, second)
      },
    })
    expect(result).toMatchObject({ ok: false })
    expect(result.action).toContain('still claimed by other conversation')
    expect(existsSync(tree)).toBe(true)
    expect(
      db()
        .query('SELECT record_id,worktree FROM run WHERE record_id IN (?,?) ORDER BY number')
        .all(first, second),
    ).toEqual([
      { record_id: first, worktree: tree },
      { record_id: second, worktree: tree },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('branch reclaim landing evidence', () => {
  test('one project branch report serves every monitor dry-run candidate', () => {
    const report = { projects: [] } as ReturnType<typeof branchesReport>
    let gathers = 0
    const seenReports: (typeof report)[] = []
    const actions = reclaimBranchesDryRun('sample', ['first', 'second'], {
      gatherReport: () => {
        gathers += 1
        return report
      },
      reclaim: (subject, sharedReport) => {
        seenReports.push(sharedReport)
        return { ok: true, action: `would reclaim ${subject}` }
      },
    })
    expect(actions).toEqual(
      new Map([
        ['first', 'would reclaim sample:first'],
        ['second', 'would reclaim sample:second'],
      ]),
    )
    expect(gathers).toBe(1)
    expect(seenReports).toEqual([report, report])
  })

  test('a dry-run gives the same decision with a shared or freshly gathered report', () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-branch-report-'))
    const bin = mkdtempSync(join(tmpdir(), 'shared-branch-report-bin-'))
    const project = `shared-report-${newRecordId()}`
    const projectRecordId = newRecordId()
    const branch = 'DEV-1592-shared-report'
    const originalPath = process.env.PATH
    try {
      git(root, ['init', '--quiet', '--initial-branch=main'])
      writeFileSync(join(root, 'README.md'), 'fixture\n')
      git(root, ['add', 'README.md'])
      git(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'fixture',
      ])
      git(root, ['remote', 'add', 'origin', root])
      git(root, ['checkout', '-qb', branch])
      writeFileSync(join(root, 'README.md'), 'branch work\n')
      git(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-am',
        'DEV-1592 branch work',
        '--quiet',
      ])
      git(root, ['checkout', '-q', 'main'])
      writeFileSync(join(bin, 'gh'), "#!/bin/sh\nprintf '%s\\n' '[]'\n")
      chmodSync(join(bin, 'gh'), 0o755)
      process.env.PATH = `${bin}:${originalPath ?? ''}`

      upsertProject({
        recordId: projectRecordId,
        name: project,
        path: root,
        settings: { trunk: 'main' },
      })
      const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
      db()
        .query(
          'UPDATE run SET project_record_id=?,launch_key=?,branch=?,minted_branch=? WHERE record_id=?',
        )
        .run(projectRecordId, 'DEV-1592', branch, branch, runId)

      const shared = branchesReport({ project })
      expect(reclaimBranch(`${project}:${branch}`, { dryRun: true, branchReport: shared })).toEqual(
        reclaimBranch(`${project}:${branch}`, { dryRun: true }),
      )
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      rmSync(root, { recursive: true, force: true })
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('refuses unreachable commits without a safe prune classification', () => {
    expect(
      decideBranchReclaimEvidence({
        absentCommits: ['abc123'],
        classification: 'unlanded',
      }),
    ).toEqual({ allowed: false, state: 'unlanded' })
    expect(
      decideBranchReclaimEvidence({
        absentCommits: ['abc123'],
        classification: 'unknown',
      }),
    ).toEqual({ allowed: false, state: 'unknown' })
  })

  test('allows reachable commits and the prune classifier safe states', () => {
    expect(
      decideBranchReclaimEvidence({
        absentCommits: [],
        classification: 'unlanded',
      }),
    ).toEqual({
      allowed: true,
      proof: 'reachable',
    })
    for (const classification of ['landed', 'superseded', 'empty'] as const) {
      expect(
        decideBranchReclaimEvidence({
          absentCommits: ['abc123'],
          classification,
        }),
      ).toEqual({
        allowed: true,
        proof: classification,
      })
    }
  })
})
