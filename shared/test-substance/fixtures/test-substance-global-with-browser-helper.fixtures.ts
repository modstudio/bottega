import { helperValue } from './test-substance-unrelated-browser-helper.fixtures'

test('global test is not derived from the helper', () => {
  expect(helperValue).toBeDefined()
})
