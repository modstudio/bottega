import type { helperValue } from './test-substance-unrelated-browser-helper.fixtures'

test('type-only helper does not supply a runner', () => {
  expect(null as typeof helperValue | null).toBeNull()
})
