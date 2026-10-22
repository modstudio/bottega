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

describe('issue before-measurement lifecycle', () => {
  test('records an evidence-excluded lifecycle run and owned read-only tree claim', () => {
    const target = targetProject()
    const created: Worktree = {
      path: '/target/.claude/worktrees/orch-before',
      repoRoot: '/target',
      branch: '',
      base: 'base-commit',
      source: 'clone',
    }
    const factoryInputs: { cwd: string; runId: string; readOnlyBase: string }[] = []

    const result = createIssueBeforeTree(target, 'base-commit', {
      createWorktree: (input) => {
        factoryInputs.push({
          cwd: input.cwd,
          runId: input.runId,
          readOnlyBase: input.readOnlyBase,
        })
        input.record?.(created)
        return created
      },
    })

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
          'SELECT job,status,evidence_excluded,worktree,branch,minted_branch,base_commit FROM run WHERE record_id=?',
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
})
