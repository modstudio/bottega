import { expect, test } from 'bun:test'
import { SETTINGS_SCOPE } from '../settings/settings.ts'
import { docBodyIsProse } from './doc-prose.ts'

test('only settings documents have structured non-prose bodies', () => {
  expect(docBodyIsProse(SETTINGS_SCOPE)).toBe(false)
  expect(docBodyIsProse('canon')).toBe(true)
  expect(docBodyIsProse('project')).toBe(true)
})
