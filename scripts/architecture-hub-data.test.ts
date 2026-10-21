import { expect, test } from 'bun:test'
import { hubViewsDocsModeLiteralLines } from './architecture-hub-data.ts'

test('docs mode literals are found in code but not comments', () => {
  expect(
    hubViewsDocsModeLiteralLines(
      "// 'hosted' is explanatory\nconst source = 'hosted'\nconst label = `local`",
    ),
  ).toEqual([2, 3])
})
