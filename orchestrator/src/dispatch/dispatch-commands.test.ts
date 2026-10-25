import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveLens } from '../lens/lenses.ts'
import {
  genericLensProfileNotices,
  lensDispatchNotices,
  reviewMemoryBranch,
  reviewRoleForDispatch,
} from './dispatch-commands.ts'

test('findings dispatch leaves the default role to run dispatch unless explicitly supplementary', () => {
  expect(reviewRoleForDispatch(true, false)).toBeUndefined()
  expect(reviewRoleForDispatch(true, true)).toBe('supplementary')
  expect(reviewRoleForDispatch(false, false)).toBeUndefined()
  expect(() => reviewRoleForDispatch(false, true)).toThrow(
    '--supplementary is only valid for findings-producing jobs',
  )
})

test('generic lens resolution names the stack-profile write command', () => {
  const notices = genericLensProfileNotices(resolveLens('correctness', null), 'node')
  expect(notices).toEqual([
    expect.stringContaining(
      `lens correctness uses generic framework body; write the stack profile with: ${PLATFORM_SLUG} review lens profile set correctness --axis framework --name node`,
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

test('explicit --review target keys memory independently of the caller checkout branch', () => {
  expect(reviewMemoryBranch('main', 'DEV-1373-target')).toBe('DEV-1373-target')
  expect(reviewMemoryBranch('DEV-1373-caller', null)).toBe('DEV-1373-caller')
})
