import { describe, expect, test } from 'bun:test'
import { parseCheckArguments, runsRootSuiteTests, selectedCheckLegs } from './check-mode.ts'

describe('check mode arguments', () => {
  test('defaults to every static leg without a shard', () => {
    const parsed = parseCheckArguments([])
    expect(parsed).toEqual({ mode: 'static' })
    expect(selectedCheckLegs(parsed)).toEqual([
      'orchestrator',
      'hub',
      'hub/web',
      'hub/deploy/site',
      'retrieval',
    ])
  })

  test('selects one suite leg and preserves a valid shard', () => {
    const parsed = parseCheckArguments(['--suite', '--only=orchestrator', '--shard=2/4'])
    expect(parsed).toEqual({
      mode: 'suite',
      only: 'orchestrator',
      shard: { index: 2, total: 4, value: '2/4' },
    })
    expect(selectedCheckLegs(parsed)).toEqual(['orchestrator'])
    expect(runsRootSuiteTests(parsed)).toBe(false)
    expect(runsRootSuiteTests(parseCheckArguments(['--suite', '--shard=1/4']))).toBe(true)
  })

  test('refuses arguments that could silently omit or mis-shard a leg', () => {
    expect(() => parseCheckArguments(['--only=hub'])).toThrow('require --suite')
    expect(() => parseCheckArguments(['--suite', '--only=unknown'])).toThrow('expected one of')
    expect(() => parseCheckArguments(['--suite', '--shard=0/4'])).toThrow('1 <= M <= N')
    expect(() => parseCheckArguments(['--suite', '--shard=3/2'])).toThrow('1 <= M <= N')
    expect(() => parseCheckArguments(['--suite', '--only=hub', '--shard=1/4'])).toThrow(
      'only to the orchestrator',
    )
    expect(() => parseCheckArguments(['--suite', '--unexpected'])).toThrow('unknown')
  })
})
