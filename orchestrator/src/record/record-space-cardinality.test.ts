import { expect, test } from 'bun:test'
import { decideSingleRecordSpace } from './record-space-cardinality.ts'

test('no record space contains the record', () => {
  expect(decideSingleRecordSpace([{ spaceId: 'space-one', found: false }])).toEqual({
    index: null,
  })
})

test('one record space contains the record', () => {
  expect(
    decideSingleRecordSpace([
      { spaceId: 'space-one', found: false },
      { spaceId: 'space-two', found: true },
    ]),
  ).toEqual({ index: 1 })
})

test('two record spaces containing the record are refused', () => {
  expect(
    decideSingleRecordSpace([
      { spaceId: 'space-one', found: true },
      { spaceId: 'space-two', found: true },
    ]),
  ).toEqual({
    refused: 'hosted task-flow record exists in more than one record space: space-one, space-two',
  })
})
