import { expect, test } from 'bun:test'
import { adapter, cwd, recordPassingGate, registerProject } from './pr-merge.fixture.ts'
import { mergePullRequest } from './pr-merge.ts'

function enqueueThenMerge() {
  let observed = false
  return () => {
    if (!observed) {
      observed = true
      return {
        pullRequestState: 'OPEN' as const,
        mergeCommit: null,
        entryState: null,
        enqueuedAt: null,
      }
    }
    return {
      pullRequestState: 'MERGED' as const,
      mergeCommit: 'merge-commit',
      entryState: null,
      enqueuedAt: null,
    }
  }
}

test('a release preflight refusal propagates before enqueue or merge', async () => {
  registerProject([], true)
  recordPassingGate()
  let enqueued = false
  let merged = false
  await expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        releasePreflight: async () => {
          throw new Error('hosted-hub credentials probe failed; run fly auth login')
        },
        queueState: enqueueThenMerge(),
        enqueue: () => {
          enqueued = true
        },
        merge: () => {
          merged = true
          return 'merge-commit'
        },
      }),
      undefined,
      true,
    ),
  ).rejects.toThrow('fly auth login')
  expect(enqueued).toBeFalse()
  expect(merged).toBeFalse()
})

test('a passing release preflight reaches enqueue', async () => {
  registerProject([], true)
  recordPassingGate()
  let preflightCalled = false
  let enqueued = false
  await mergePullRequest(
    '42',
    cwd,
    adapter({
      releasePreflight: async () => {
        preflightCalled = true
      },
      queueState: enqueueThenMerge(),
      enqueue: () => {
        enqueued = true
      },
    }),
    undefined,
    true,
  )
  expect(preflightCalled).toBeTrue()
  expect(enqueued).toBeTrue()
})

test('a merge that does not require release skips preflight and reaches enqueue', async () => {
  registerProject([], true)
  recordPassingGate()
  let preflightCalled = false
  let enqueued = false
  await mergePullRequest(
    '42',
    cwd,
    adapter({
      releasePreflight: async () => {
        preflightCalled = true
      },
      queueState: enqueueThenMerge(),
      enqueue: () => {
        enqueued = true
      },
    }),
    undefined,
    false,
  )
  expect(preflightCalled).toBeFalse()
  expect(enqueued).toBeTrue()
})
