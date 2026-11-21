import { expect, test } from 'bun:test'
import { adapter, cwd, recordPassingGate, registerProject } from './pr-merge.fixture.ts'
import { mergePullRequest } from './pr-merge.ts'

test('a release preflight refusal propagates before enqueue', async () => {
  registerProject([], true)
  recordPassingGate()
  let enqueued = false
  expect(
    mergePullRequest(
      '42',
      cwd,
      adapter({
        releasePreflight: async () => {
          throw new Error('hosted-hub credentials probe failed; run fly auth login')
        },
        enqueue: () => {
          enqueued = true
        },
      }),
      undefined,
      true,
    ),
  ).rejects.toThrow('fly auth login')
  expect(enqueued).toBeFalse()
})
