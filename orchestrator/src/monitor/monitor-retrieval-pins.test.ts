import { expect, test } from 'bun:test'
import { staleRetrievalPinConditions } from './monitor-retrieval-pins.ts'

test('stale retrieval pins become report-only monitor conditions', () => {
  expect(
    staleRetrievalPinConditions({
      pins: [
        {
          queryId: 'current-pin',
          doc: 'doc:project/sample/guide',
          docSlug: 'guide',
          excerpt: 'current excerpt',
          revision: 'revision-8',
          current: true,
        },
        {
          queryId: 'stale-pin',
          doc: 'doc:project/sample/guide',
          docSlug: 'guide',
          excerpt: 'stale excerpt',
          revision: 'revision-8',
          current: false,
        },
      ],
    }),
  ).toEqual([
    {
      kind: 'stale-retrieval-benchmark-pin',
      subject: 'stale-pin',
      since: null,
      ageMs: null,
      detail: 'stale-pin excerpt is absent from guide at revision revision-8: "stale excerpt"',
      action:
        'repin stale-pin by hand in retrieval/src/benchmark/queries.ts after deciding what the query should retrieve',
    },
  ])
})
