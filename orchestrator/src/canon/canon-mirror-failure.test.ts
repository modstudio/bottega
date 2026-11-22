import { expect, test } from 'bun:test'
import { composeMirrorFailure } from './canon-mirror-failure.ts'

test('cleanup failure appends to the original failure', () => {
  expect(composeMirrorFailure('canon lint refused the file', 'canon mirror cleanup held')).toBe(
    'canon lint refused the file; canon mirror cleanup held',
  )
  expect(composeMirrorFailure(null, 'canon mirror cleanup held')).toBe('canon mirror cleanup held')
})
