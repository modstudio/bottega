import { describe, expect, test } from 'bun:test'
import { firstSampleLink, slowestFirst } from './page-probe-decision.ts'

describe('page probe decisions', () => {
  test('takes the first same-origin link with the exact parameterized route shape', () => {
    const origin = 'https://hub.example.test'
    expect(
      firstSampleLink(
        '/docs/$scope/$subject/$slug',
        [
          'https://other.example/docs/canon/project/one',
          '/docs/canon/project/first?revision=2',
          '/docs/canon/project/second',
        ],
        origin,
      ),
    ).toBe('/docs/canon/project/first?revision=2')
    expect(firstSampleLink('/runs/$id', ['/runs', '/runs/one/more'], origin)).toBeNull()
  })

  test('ranks measured rows slowest first and leaves no-sample rows last', () => {
    const rows = slowestFirst([
      { route: '/fast', settleMs: 4 },
      { route: '/missing', settleMs: null },
      { route: '/slow', settleMs: 12 },
    ])
    expect(rows.map((row) => row.route)).toEqual(['/slow', '/fast', '/missing'])
  })
})
