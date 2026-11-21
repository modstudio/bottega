import { describe, expect, test } from 'bun:test'
import { gateTestArguments } from './gate-shard.ts'

describe('gate shard arguments', () => {
  test('accepts one bounded Bun shard argument', () => {
    expect(gateTestArguments([])).toEqual({ shardArguments: [], timeoutArguments: [] })
    expect(gateTestArguments(['--shard=2/4', '--timeout=60000'])).toEqual({
      shardArguments: ['--shard=2/4'],
      timeoutArguments: ['--timeout=60000'],
    })
    expect(gateTestArguments(['--timeout=60000', '--shard=2/4'])).toEqual({
      shardArguments: ['--shard=2/4'],
      timeoutArguments: ['--timeout=60000'],
    })
  })

  test('refuses malformed, out-of-range, or extra arguments', () => {
    expect(() => gateTestArguments(['--shard=0/4'])).toThrow('1 <= M <= N')
    expect(() => gateTestArguments(['--shard=5/4'])).toThrow('1 <= M <= N')
    expect(() => gateTestArguments(['--shard=one/four'])).toThrow('only one --shard=M/N')
    expect(() => gateTestArguments(['--shard=1/4', '--watch'])).toThrow(
      'only one --shard=M/N and one --timeout=N',
    )
    expect(() => gateTestArguments(['--timeout=0'])).toThrow('only one --shard=M/N')
    expect(() => gateTestArguments(['--timeout=1', '--timeout=2'])).toThrow(
      'only one --shard=M/N and one --timeout=N',
    )
  })
})
