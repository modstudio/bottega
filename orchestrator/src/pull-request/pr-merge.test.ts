import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { db } from '../database/db.ts'
import type { PullRequestCheck } from './merge-decision.ts'
import {
  mergePullRequest,
  type PullRequestMergeAdapter,
  type PullRequestMergeFacts,
} from './pr-merge.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

function registerProject(requiredChecks: string[]): void {
  db()
    .query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)')
    .run(
      'merge-fixture',
      cwd,
      'bun',
      JSON.stringify({
        trunk: 'main',
        release: { rungs: [], mergeMethod: 'squash', requiredChecks },
      }),
    )
}

const pullRequest: PullRequestMergeFacts = {
  number: 42,
  headCommit: 'head-commit',
  baseBranch: 'main',
  title: 'Prove the pull request head',
  state: 'OPEN',
}

function adapter(
  input: {
    view?: (target: string) => PullRequestMergeFacts
    checks?: PullRequestCheck[]
    landingState?: () => { remoteLandingTip: string; mergeBase: string }
    merge?: (method: string, subject: string, headCommit: string) => string
  } = {},
): PullRequestMergeAdapter {
  return {
    view: (_cwd, target) => input.view?.(target) ?? pullRequest,
    checks: () => input.checks ?? [],
    landingState: input.landingState ?? (() => ({ remoteLandingTip: 'base', mergeBase: 'base' })),
    merge: (_cwd, _number, method, subject, headCommit) =>
      input.merge?.(method, subject, headCommit) ?? 'merge-commit',
  }
}

function recordPassingGate(): void {
  db()
    .query(
      `INSERT INTO gate_execution
        (requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit,cwd)
       VALUES ('2026-10-09','2026-10-09',0,0,100,'passed',?,?)`,
    )
    .run(pullRequest.headCommit, cwd)
}

test('an injected forge adapter merges all-passing checks with the method, subject, and proven head', () => {
  registerProject(['test'])
  const calls: [string, string, string][] = []
  const commit = mergePullRequest(
    '42',
    cwd,
    adapter({
      checks: [
        {
          name: 'test',
          bucket: 'pass',
          state: 'SUCCESS',
          link: 'https://checks.example/test',
        },
      ],
      merge: (method, subject, headCommit) => {
        calls.push([method, subject, headCommit])
        return 'merged-oid'
      },
    }),
  )
  expect(commit).toBe('merged-oid')
  expect(calls).toEqual([['squash', 'Prove the pull request head (#42)', 'head-commit']])
})

test('an injected forge adapter exposes a pending required check without merging', () => {
  registerProject(['test'])
  let merged = false
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        checks: [
          {
            name: 'test',
            bucket: 'pending',
            state: 'IN_PROGRESS',
            link: 'https://checks.example/test',
          },
        ],
        merge: () => {
          merged = true
          return 'unexpected'
        },
      }),
    ),
  ).toThrow('test: IN_PROGRESS (https://checks.example/test)')
  expect(merged).toBe(false)
})

test('a failing forge call refuses because proof was not checked', () => {
  registerProject(['test'])
  expect(() =>
    mergePullRequest(
      'https://github.com/example/repo/pull/42',
      cwd,
      adapter({
        view: () => {
          throw new Error('forge unavailable')
        },
      }),
    ),
  ).toThrow('proof was not checked: forge unavailable')
})

test('a head commit that changes after checks is refused without merging', () => {
  registerProject(['test'])
  let views = 0
  let merged = false
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        view: () => ({
          ...pullRequest,
          headCommit: views++ === 0 ? 'head-commit' : 'changed-head-commit',
        }),
        checks: [
          {
            name: 'test',
            bucket: 'pass',
            state: 'SUCCESS',
            link: 'https://checks.example/test',
          },
        ],
        merge: () => {
          merged = true
          return 'unexpected'
        },
      }),
    ),
  ).toThrow('head changed from head-commit to changed-head-commit')
  expect(merged).toBe(false)
})

test('a missing recorded local gate refuses with the gate command', () => {
  registerProject([])
  expect(() => mergePullRequest('42', cwd, adapter())).toThrow('run orch gate run')
})

test('a moved landing branch refuses after reading the recorded local gate', () => {
  registerProject([])
  recordPassingGate()
  expect(() =>
    mergePullRequest(
      '42',
      cwd,
      adapter({
        landingState: () => ({ remoteLandingTip: 'new-base', mergeBase: 'old-base' }),
      }),
    ),
  ).toThrow('bring the branch up to origin/main, run orch gate run')
})
