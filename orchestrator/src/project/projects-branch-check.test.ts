import { expect, test } from 'bun:test'
import { detachedCheckoutDecision } from './projects.ts'

const checkout = '/projects/development'
const project = 'development'

test('a detached checkout at a release tag names that tag', () => {
  expect(detachedCheckoutDecision('main', true, ['v0.2.0'], checkout, project)).toBe(
    'release tag v0.2.0 is checked out; a development checkout stays on its landing branch main\n' +
      `cleared by: git -C ${checkout} switch main`,
  )
})

test('a detached checkout away from a release tag keeps the existing message', () => {
  expect(detachedCheckoutDecision('main', true, [], checkout, project)).toBe(
    'checkout HEAD is detached, not landing branch main\n' +
      `cleared by: check out main in ${checkout} or correct it with orch project set ${project} --settings '{"trunk":"<branch>"}'`,
  )
})

test('a detached checkout at a non-release tag keeps the existing message', () => {
  expect(detachedCheckoutDecision('main', true, ['release-0.2.0'], checkout, project)).toBe(
    'checkout HEAD is detached, not landing branch main\n' +
      `cleared by: check out main in ${checkout} or correct it with orch project set ${project} --settings '{"trunk":"<branch>"}'`,
  )
})

test('a checkout on the landing branch has no detached-head problem', () => {
  expect(detachedCheckoutDecision('main', false, ['v0.2.0'], checkout, project)).toBeNull()
})
