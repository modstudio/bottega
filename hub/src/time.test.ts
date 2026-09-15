import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { easternTime } from './time.ts'

beforeAll(resetFixtureStore)

describe('Eastern timestamps', () => {
  test('uses Eastern time with a 12-hour clock and lowercase am/pm', () => {
    expect(easternTime('2026-09-02T19:07:00.000Z')).toBe('3:07 pm')
    expect(easternTime('2026-09-03T03:07:00.000Z', true)).toBe('Sep 2 11:07 pm')
  })
})
