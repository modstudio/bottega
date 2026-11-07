import { expect, test } from 'bun:test'
import { verifiedReleaseCheckoutRestore } from './release-service.ts'

test('release checkout verification is skipped when no trunk restore occurred', () => {
  let calls = 0
  expect(verifiedReleaseCheckoutRestore('/project', 'main', null, false, () => calls++)).toEqual({
    restoreWarning: null,
    restoreBreach: null,
  })
  expect(calls).toBe(0)
})

test('release checkout verification is skipped when restore already warned', () => {
  let calls = 0
  expect(
    verifiedReleaseCheckoutRestore('/project', 'main', 'restore failed', true, () => calls++),
  ).toEqual({ restoreWarning: 'restore failed', restoreBreach: null })
  expect(calls).toBe(0)
})

test('release checkout verification reports a breach', () => {
  expect(
    verifiedReleaseCheckoutRestore('/project', 'main', null, true, () => {
      throw new Error('checkout has tracked modifications; restore it')
    }),
  ).toEqual({
    restoreWarning: null,
    restoreBreach:
      'registered main checkout could not be restored to landing branch main: checkout has tracked modifications; restore it; run git -C /project switch main',
  })
})

test('release checkout verification accepts a clean restore', () => {
  expect(verifiedReleaseCheckoutRestore('/project', 'main', null, true, () => {})).toEqual({
    restoreWarning: null,
    restoreBreach: null,
  })
})
