import { expect, test } from 'bun:test'
import { parseBuiltCommit } from '../../shared/built-commit.ts'
import { hostedVersionResponse } from './hosted-version.ts'

const request = (accept = '*/*') =>
  new Request('https://hub.example.test/version', { headers: { accept } })

test('reports the hosted commit even when the client accepts HTML', async () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  for (const accept of ['*/*', 'text/html,application/xhtml+xml']) {
    const response = hostedVersionResponse(request(accept), commit)
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ commit })
  }
})

test.each([undefined, '0123456', 'g123456789abcdef0123456789abcdef01234567'])(
  'reports an unknown commit for %p',
  async (commit) => {
    const response = hostedVersionResponse(request(), parseBuiltCommit(commit))
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({
      commit: null,
      error: 'the commit this app was built from is unknown',
    })
  },
)
