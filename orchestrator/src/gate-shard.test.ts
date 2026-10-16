import { describe, expect, test } from 'bun:test'
import { gateShardArguments } from './gate-shard.ts'

describe('gate shard arguments', () => {
  test('accepts one bounded Bun shard argument', () => {
    expect(gateShardArguments([])).toEqual([])
    expect(gateShardArguments(['--shard=2/4'])).toEqual(['--shard=2/4'])
  })

  test('refuses malformed, out-of-range, or extra arguments', () => {
    expect(() => gateShardArguments(['--shard=0/4'])).toThrow('1 <= M <= N')
    expect(() => gateShardArguments(['--shard=5/4'])).toThrow('1 <= M <= N')
    expect(() => gateShardArguments(['--shard=one/four'])).toThrow('only --shard=M/N')
    expect(() => gateShardArguments(['--shard=1/4', '--watch'])).toThrow('only --shard=M/N')
  })
})
