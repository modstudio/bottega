import { describe, expect, test } from 'bun:test'
import { endpointsFromEnvironment, probeEndpoints } from './endpoints.ts'

describe('retrieval endpoints', () => {
  test('uses documented defaults', () => {
    expect(endpointsFromEnvironment({})).toEqual({
      embedUrl: 'http://127.0.0.1:8011/v1',
      rerankUrl: 'http://127.0.0.1:8012/v1',
    })
  })

  test('refuses with the tunnel remedy when an endpoint is absent', async () => {
    const absent = () => Promise.reject(new Error('connection refused'))

    await expect(
      probeEndpoints({ embedUrl: 'http://embed/v1', rerankUrl: 'http://rerank/v1' }, absent),
    ).rejects.toThrow(
      'embedding endpoint could not be established at http://embed/v1/embeddings: connection refused. Run `launchctl kickstart -k gui/$(id -u)/com.user.gx10-services-tunnel` and retry.',
    )
  })
})
