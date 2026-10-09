import { expect, test } from 'bun:test'
import { detachedCheckoutDecision } from './projects.ts'

const checkout = '/projects/bottega'

test('a detached checkout at a release tag names that tag', () => {
  expect(detachedCheckoutDecision('main', true, ['v0.2.0'], checkout)).toEqual({
    releaseTag: 'v0.2.0',
    message:
      'release tag v0.2.0 is checked out; a development checkout stays on its landing branch main\n' +
      `cleared by: git -C ${checkout} switch main`,
  })
})

test('a detached checkout away from a release tag keeps the existing message', () => {
  expect(detachedCheckoutDecision('main', true, [], checkout)).toEqual({
    releaseTag: null,
    message: 'checkout HEAD is detached, not landing branch main',
  })
})

test('a checkout on the landing branch has no detached-head problem', () => {
  expect(detachedCheckoutDecision('main', false, ['v0.2.0'], checkout)).toBeNull()
})
