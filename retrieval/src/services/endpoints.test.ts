import { describe, expect, test } from 'bun:test'
import { endpointsFromEnvironment, probeEndpoints } from './endpoints.ts'

describe('retrieval endpoints', () => {
  test('uses documented defaults', () => {
    expect(endpointsFromEnvironment({})).toEqual({
      embedUrl: 'http://127.0.0.1:8011/v1',
      rerankUrl: 'http://127.0.0.1:8012/v1',
    })
  })

  test('refuses with the doctor remedy when an endpoint is absent', async () => {
    const absent = () => Promise.reject(new Error('connection refused'))

    await expect(
      probeEndpoints({ embedUrl: 'http://embed/v1', rerankUrl: 'http://rerank/v1' }, absent),
    ).rejects.toThrow(
      'embedding endpoint could not be established at http://embed/v1/embeddings: connection refused. Run `orch doctor` to check model-host reachability and retry.',
    )
  })
})
