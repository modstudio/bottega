import { describe, expect, test } from 'bun:test'
import { endpointsFromEnvironment, probeEndpointStatuses, probeEndpoints } from './endpoints.ts'

describe('retrieval endpoints', () => {
  test('uses documented defaults', () => {
    expect(endpointsFromEnvironment({})).toEqual({
      embedUrl: 'http://127.0.0.1:8011/v1',
      rerankUrl: 'http://127.0.0.1:8012/v1',
    })
  })

  test('refuses with the retrieval check remedy when an endpoint is absent', async () => {
    const absent = () => Promise.reject(new Error('connection refused'))

    await expect(
      probeEndpoints({ embedUrl: 'http://embed/v1', rerankUrl: 'http://rerank/v1' }, absent),
    ).rejects.toThrow(
      'embedding endpoint could not be established at http://embed/v1/embeddings: connection refused. Run `bin/retrieval-search --check` and retry. Configure the endpoints with ORCH_EMBED_URL and ORCH_RERANK_URL.',
    )
  })

  test('check probes both configured endpoints when one is unreachable', async () => {
    const seen: string[] = []
    const statuses = await probeEndpointStatuses(
      { embedUrl: 'http://embed/v1', rerankUrl: 'http://rerank/v1' },
      async (input) => {
        seen.push(String(input))
        if (String(input).endsWith('/embeddings')) throw new Error('connection refused')
        return Response.json({ results: [{ index: 0, relevance_score: 1 }] })
      },
    )

    expect(seen).toEqual(['http://embed/v1/embeddings', 'http://rerank/v1/rerank'])
    expect(statuses).toEqual([
      { kind: 'embedding', url: 'http://embed/v1', reachable: false },
      { kind: 'reranking', url: 'http://rerank/v1', reachable: true },
    ])
  })
})
