import { expect, test } from 'bun:test'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { LOCAL_LOGIN_MESSAGE } from './local-auth.ts'
import { handleTrpcRequest, trpcMutationRequestAllowed } from './serve.ts'
import type { AppRouter } from './trpc/router.ts'

test('tRPC mutation requests require browser same-origin proof', () => {
  const request = (headers?: HeadersInit, method = 'POST') =>
    new Request('http://127.0.0.1:4567/trpc/run.score', { method, headers })
  expect(trpcMutationRequestAllowed(request({ Origin: 'http://127.0.0.1:4567' }))).toBe(true)
  expect(trpcMutationRequestAllowed(request({ 'Sec-Fetch-Site': 'same-origin' }))).toBe(true)
  expect(trpcMutationRequestAllowed(request({ Origin: 'https://attacker.example' }))).toBe(false)
  expect(trpcMutationRequestAllowed(request({ 'Content-Type': 'text/plain' }))).toBe(false)
  expect(trpcMutationRequestAllowed(request(undefined, 'GET'))).toBe(true)
})

function trpcClient(origin: string, auth: { allows(request: Request): boolean }) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'http://127.0.0.1:4567/trpc',
        fetch(input, init) {
          const request = new Request(input, init)
          request.headers.set('Origin', origin)
          return handleTrpcRequest(request, auth)
        },
      }),
    ],
  })
}

async function mutationError(origin: string, allows: boolean): Promise<TRPCClientError<AppRouter>> {
  try {
    await trpcClient(origin, { allows: () => allows }).run.score.mutate({
      id: 1,
      delivery: 'none',
      quality: null,
      fidelity: null,
      note: null,
    })
    throw new Error('expected mutation to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCClientError)
    return error as TRPCClientError<AppRouter>
  }
}

test('a refused local session returns the tRPC remedy through the dashboard transport', async () => {
  const error = await mutationError('http://127.0.0.1:4567', false)

  expect(error.data?.code).toBe('UNAUTHORIZED')
  expect(error.message).toBe(LOCAL_LOGIN_MESSAGE)
})

test('a foreign origin returns the tRPC refusal through the dashboard transport', async () => {
  const error = await mutationError('https://attacker.example', true)

  expect(error.data?.code).toBe('FORBIDDEN')
  expect(error.message).toBe('cross-origin tRPC mutation refused')
})
