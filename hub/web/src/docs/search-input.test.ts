import { expect, test } from 'bun:test'
import { docsSearchInputs } from './search-input.ts'

test('local and signed-in search carry the draft choice while public search cannot', () => {
  const hidden = docsSearchInputs('guide', 'user', 'workshop', false)
  expect(hidden.local.includeDrafts).toBeFalse()
  expect(hidden.hosted.includeDrafts).toBeFalse()

  const shown = docsSearchInputs('guide', 'user', 'workshop', true)
  expect(shown.local.includeDrafts).toBeTrue()
  expect(shown.hosted.includeDrafts).toBeTrue()
  expect(shown.public).toEqual({ query: 'guide' })
})
