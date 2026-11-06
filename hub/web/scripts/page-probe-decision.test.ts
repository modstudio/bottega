import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  firstSampleLink,
  routeFileTemplate,
  slowestFirst,
  unprobedRouteTemplates,
} from './page-probe-decision.ts'

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

  test('every parameterized route file is probed, sampled or untimed', () => {
    const routes = fileURLToPath(new URL('../src/routes', import.meta.url))
    const templates = readdirSync(routes)
      .map(routeFileTemplate)
      .filter((template): template is string => template !== null)
    expect(templates).toContain('/inbox/$kind/$id')
    expect(unprobedRouteTemplates(templates)).toEqual([])
    expect(unprobedRouteTemplates(['/agents/$name'])).toEqual(['/agents/$name'])
  })
})
