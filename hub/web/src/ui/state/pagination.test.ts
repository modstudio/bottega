import { expect, test } from 'bun:test'
import { pageSlice } from './pagination'

const rows = Array.from({ length: 23 }, (_, index) => index + 1)

test('a middle page reports its own range', () => {
  const slice = pageSlice(rows, 2, 10)
  expect(slice.rows).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  expect([slice.first, slice.last, slice.total, slice.pageCount]).toEqual([11, 20, 23, 3])
})

test('a page past the end clamps to the last page, as when a search shrinks the list', () => {
  const slice = pageSlice(rows, 9, 10)
  expect(slice.page).toBe(3)
  expect(slice.rows).toEqual([21, 22, 23])
  expect(slice.last).toBe(23)
})

test('an empty list is one empty page', () => {
  const slice = pageSlice([], 1, 10)
  expect([slice.page, slice.pageCount, slice.first, slice.last]).toEqual([1, 1, 0, 0])
})
