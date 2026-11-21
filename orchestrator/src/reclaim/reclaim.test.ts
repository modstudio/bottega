import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { branchMonitorConditions } from '../monitor/monitor-branches.ts'
import { upsertProject } from '../project/projects.ts'
import {
  decideBranchReclaimEvidence,
  reclaimBranchesDryRun,
  reclaimWorktree,
  sharedWorktreeRefusal,
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

test("reclaim refuses another run's claimed worktree claim", () => {
  const owner = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const claimant = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const path = '/tmp/reclaim-claimed-worktree'
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,settled_at)
       VALUES (?,?,?,?, 'worktree', ?,NULL,NULL,'claimed',?,NULL)`,
    )
    .run(newRecordId(), claimant, claimant, null, path, '2026-11-21T00:00:00.000Z')

  expect(sharedWorktreeRefusal(path, owner)).toEqual({
    ok: false,
    action:
      `refused; worktree ${path} is in use by run(s) ${claimant}; ` +
      `once run ${claimant} is finished with the tree, close it out with ` +
      `${PLATFORM_SLUG} run close-out ${claimant}`,
  })
})

test("reclaim does not treat a child turn's root claim as another owner", () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2 })
  const path = '/tmp/reclaim-own-chain-worktree'
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,settled_at)
       VALUES (?,?,?,?, 'worktree', ?,NULL,NULL,'claimed',?,NULL)`,
    )
    .run(newRecordId(), root, child, null, path, '2026-11-21T00:00:00.000Z')

  expect(sharedWorktreeRefusal(path, child)).toBeNull()
})

test('reclaim refuses a claimed worktree even when no run points at its path', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claim-only-reclaim-')))
  const tree = join(root, '.claude', 'worktrees', 'claim-only')
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
  git(root, ['worktree', 'add', '--quiet', '-b', 'claim-only-reclaim', tree])
  const project = `claim-only-reclaim-${newRecordId()}`
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: root,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  const claimant = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
        identity,label,state,claimed_at,settled_at)
       VALUES (?,?,?,?, 'worktree', ?,NULL,NULL,'claimed',?,NULL)`,
    )
    .run(newRecordId(), claimant, claimant, null, tree, '2026-11-21T00:00:00.000Z')

  try {
    const result = reclaimWorktree(tree)
    expect(result).toMatchObject({ ok: false })
    expect(result.action).toContain(`worktree ${tree} is in use by run(s) ${claimant}`)
    expect(existsSync(tree)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('branch reclaim landing evidence', () => {
  test('a failed report gather errors every candidate without dropping conditions', () => {
    let gathers = 0
    const candidates = [
      { branch: 'first', started_at: '2026-09-30T10:00:00.000Z' },
      { branch: 'second', started_at: '2026-09-30T11:00:00.000Z' },
    ]
    const actions = reclaimBranchesDryRun(
      'sample',
      candidates.map((candidate) => candidate.branch),
      () => {
        gathers += 1
        throw new Error('GitHub unavailable')
      },
    )
    expect(gathers).toBe(1)
    const conditions = branchMonitorConditions('sample', candidates, actions)
    expect(conditions).toHaveLength(2)
    expect(conditions.map((condition) => condition.action)).toEqual([
      'reported; reclaim errored: GitHub unavailable',
      'reported; reclaim errored: GitHub unavailable',
    ])
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
        classification: 'superseded',
      }),
    ).toEqual({ allowed: false, state: 'superseded' })
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
    expect(
      decideBranchReclaimEvidence({
        absentCommits: [],
        classification: 'superseded',
      }),
    ).toEqual({
      allowed: true,
      proof: 'reachable',
    })
    for (const classification of ['landed', 'empty'] as const) {
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
