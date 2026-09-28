import { expect, mock, test } from 'bun:test'
import { fetchWithHubCredentials } from './transport.ts'

test('local mutation transport sends the login cookie and reports an expired session', async () => {
  const fetcher = mock(async () => new Response('unauthorized', { status: 401 }))
  const unauthorized = mock(() => {})

  await fetchWithHubCredentials(fetcher, false, unauthorized, '/trpc/project.add', {
    method: 'POST',
  })

  expect(fetcher).toHaveBeenCalledWith('/trpc/project.add', {
    method: 'POST',
    credentials: 'same-origin',
  })
  expect(unauthorized).toHaveBeenCalledTimes(1)
})
