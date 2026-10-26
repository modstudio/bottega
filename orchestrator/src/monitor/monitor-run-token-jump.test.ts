import { describe, expect, test } from 'bun:test'
import { MIN_SAMPLE } from '../route/route.ts'
import { runTokenJump } from './monitor-run-token-jump.ts'

const values = (value: number, count = MIN_SAMPLE) => Array.from({ length: count }, () => value)

describe('tokens per run jump decision', () => {
  test('reports a doubled cell', () => {
    expect(
      runTokenJump({
        agent: 'goose',
        job: 'implement',
        recentTokens: values(200),
        baselineTokens: values(100),
      }),
    ).toMatchObject({ agent: 'goose', job: 'implement', recentMedian: 200, baselineMedian: 100 })
  })

  test('does not report a steady cell', () => {
    expect(
      runTokenJump({
        agent: 'goose',
        job: 'implement',
        recentTokens: values(120),
        baselineTokens: values(100),
      }),
    ).toBeNull()
  })

  test('does not report a thin sample on either side', () => {
    expect(
      runTokenJump({
        agent: 'goose',
        job: 'implement',
        recentTokens: values(200, MIN_SAMPLE - 1),
        baselineTokens: values(100),
      }),
    ).toBeNull()
  })
})
