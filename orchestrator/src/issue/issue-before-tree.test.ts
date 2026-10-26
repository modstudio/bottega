import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'
import { ISSUE_BEFORE_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { createIssueBeforeTree } from './issue-before-tree.ts'

function targetProject(): Project {
  const recordId = newRecordId()
  db()
    .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(recordId, 'issue-before-target', '/target', 'bun', '{}')
  return {
    recordId,
    name: 'issue-before-target',
    path: '/target',
    stack: 'bun',
    canon: false,
    retiredAt: null,
    settings: {},
  }
}

const repoRootOfTarget = () => '/target'

type BeforeTreeRunRow = {
  record_id: string
  job: string
  status: string
  exit_code: number | null
  error: string | null
  worktree: string | null
  base_commit: string | null
  worktree_source: string | null
}

function latestBeforeTreeRun(): BeforeTreeRunRow | null {
  return db()
    .query<BeforeTreeRunRow, [string]>(
      `SELECT record_id,job,status,exit_code,error,worktree,base_commit,worktree_source FROM run WHERE job=? ORDER BY number DESC LIMIT 1`,
    )
    .get(ISSUE_BEFORE_TREE_JOB)
}

describe('issue before-measurement lifecycle', () => {
  test('records an evidence-excluded lifecycle run and owned read-only tree claim', () => {
    const target = targetProject()
    const trees: Worktree[] = []
    const factoryInputs: { cwd: string; runId: string; readOnlyBase: string }[] = []

    const result = createIssueBeforeTree(target, 'base-commit', {
      repoRoot: repoRootOfTarget,
      createWorktree: (input) => {
        factoryInputs.push({
          cwd: input.cwd,
          runId: input.runId,
          readOnlyBase: input.readOnlyBase,
        })
        const created: Worktree = {
          path: `/target/.claude/worktrees/orch-${input.runId}`,
          repoRoot: '/target',
          branch: '',
          base: 'base-commit',
          source: 'clone',
        }
        trees.push(created)
        input.record?.(created)
        return created
      },
    })
    const created = trees[0]!

    expect(result).toEqual({ runId: expect.any(String), worktree: created })
    expect(factoryInputs).toEqual([
      {
        cwd: target.path,
        runId: result.runId,
        readOnlyBase: 'base-commit',
      },
    ])
    expect(
      db()
        .query(
          'SELECT job,status,evidence_excluded,worktree,branch,minted_branch,base_commit,worktree_source FROM run WHERE record_id=?',
        )
        .get(result.runId),
    ).toEqual({
      job: ISSUE_BEFORE_TREE_JOB,
      status: 'running',
      evidence_excluded: 'issue before-measurement lifecycle row; not agent execution',
      worktree: created.path,
      branch: null,
      minted_branch: null,
      base_commit: created.base,
      worktree_source: 'clone',
    })
    expect(
      db()
        .query(
          'SELECT kind,state,allocation_key,root_run_record_id FROM resource_claim WHERE root_run_record_id=?',
        )
        .all(result.runId),
    ).toEqual([
      {
        kind: 'worktree',
        state: 'claimed',
        allocation_key: created.path,
        root_run_record_id: result.runId,
      },
    ])
  })

  test('marks the lifecycle run failed when read-only tree creation throws', () => {
    const target = targetProject()

    expect(() =>
      createIssueBeforeTree(target, 'base-commit', {
        repoRoot: repoRootOfTarget,
        createWorktree: () => {
          throw new Error('clone refused')
        },
      }),
    ).toThrow('clone refused')

    expect(
      db()
        .query(
          'SELECT job,status,exit_code,error,evidence_excluded FROM run WHERE job=? ORDER BY number DESC LIMIT 1',
        )
        .get(ISSUE_BEFORE_TREE_JOB),
    ).toEqual({
      job: ISSUE_BEFORE_TREE_JOB,
      status: 'failed',
      exit_code: 1,
      error: 'Error: clone refused',
      evidence_excluded: 'issue before-measurement lifecycle row; not agent execution',
    })
  })

  test('a creation that throws leaves the intended checkout, its source and its claim recorded', () => {
    const target = targetProject()

    expect(() =>
      createIssueBeforeTree(target, 'base-commit', {
        repoRoot: repoRootOfTarget,
        createWorktree: () => {
          throw new Error('clone refused after half-creating the checkout')
        },
      }),
    ).toThrow('clone refused after half-creating the checkout')

    const row = latestBeforeTreeRun()!
    const intended = `/target/.claude/worktrees/orch-${row.record_id}`
    expect(row).toMatchObject({
      status: 'failed',
      worktree: intended,
      base_commit: 'base-commit',
      // The resolved tool declares no readonly_create, so the tree is a plain clone.
      worktree_source: 'clone',
    })
    expect(
      db()
        .query(
          'SELECT kind,state,allocation_key,root_run_record_id FROM resource_claim WHERE root_run_record_id=?',
        )
        .all(row.record_id),
    ).toEqual([
      {
        kind: 'worktree',
        state: 'claimed',
        allocation_key: intended,
        root_run_record_id: row.record_id,
      },
    ])
  })

  test('refuses before creating when the target has no git repository to root a checkout', () => {
    const target = targetProject()
    let createCalled = false

    expect(() =>
      createIssueBeforeTree(target, 'base-commit', {
        repoRoot: () => null,
        createWorktree: () => {
          createCalled = true
          throw new Error('must not create a checkout without a repository root')
        },
      }),
    ).toThrow('is not one')

    expect(createCalled).toBe(false)
    const row = latestBeforeTreeRun()!
    expect(row).toMatchObject({
      status: 'failed',
      exit_code: 1,
      worktree: null,
      error: `Error: issue before-measurement checkout for run ${row.record_id} needs a git repository: /target is not one`,
    })
    expect(
      db()
        .query('SELECT record_id FROM resource_claim WHERE root_run_record_id=?')
        .all(row.record_id),
    ).toEqual([])
  })
})
