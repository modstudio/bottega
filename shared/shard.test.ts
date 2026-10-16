import { expect, test } from 'bun:test'
import { parseShard } from './shard.ts'

test('parses a bounded M/N shard', () => {
  expect(parseShard('2/4')).toEqual({ index: 2, total: 4, value: '2/4' })
})

test('refuses malformed and out-of-range shards', () => {
  expect(() => parseShard('one/four')).toThrow('expected M/N')
  expect(() => parseShard('0/4')).toThrow('1 <= M <= N')
  expect(() => parseShard('5/4')).toThrow('1 <= M <= N')
})
