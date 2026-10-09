import { expect, test } from 'bun:test'
import { resolveLens } from '../lens/lenses.ts'
import { genericLensProfileNotices, lensDispatchNotices } from './dispatch-commands.ts'

test('generic lens resolution names the stack-profile write command', () => {
  const notices = genericLensProfileNotices(resolveLens('correctness', null), 'node')
  expect(notices).toEqual([
    expect.stringContaining(
      'lens correctness uses generic framework body; write the stack profile with: orch lens profile set correctness --axis framework --name node',
    ),
  ])
})

test('unknown catalogue lens notice is omitted for the free-form inline job', () => {
  expect(
    lensDispatchNotices({
      jobName: 'review-lens-inline',
      lens: 'project-specific-review',
      resolved: null,
      stack: 'node',
    }),
  ).toEqual([])
})
