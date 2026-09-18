import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { AppRouter } from '../../../src/trpc/router.ts'
import { isHostedMode } from '../lib/hub-mode.ts'

function isUnauthorized(error: unknown) {
  return error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED'
}

function redirectToSignIn() {
  if (!isHostedMode()) return
  if (window.location.pathname === '/sign-in') return
  window.location.assign('/sign-in')
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (isHostedMode() && isUnauthorized(error)) return false
        return failureCount < 3
      },
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) redirectToSignIn()
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorized(error)) redirectToSignIn()
    },
  }),
})

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/trpc',
      fetch(url, options) {
        const init = (options ?? {}) as RequestInit
        return fetch(url, {
          ...init,
          credentials: isHostedMode() ? 'include' : init.credentials,
        })
      },
    }),
  ],
})

export const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })

export type ProjectRow = inferRouterOutputs<AppRouter>['project']['list'][number]
export type FlightResponse = inferRouterOutputs<AppRouter>['work']['flight']
export type BoardResponse = inferRouterOutputs<AppRouter>['work']['board']
export type SettingsResponse = inferRouterOutputs<AppRouter>['settings']['get']
export type RecordSettingsResponse = inferRouterOutputs<AppRouter>['record']['settings']
export type TaskRecordResponse = inferRouterOutputs<AppRouter>['work']['task']
export type JobRow = inferRouterOutputs<AppRouter>['catalog']['jobs'][number]
export type AgentRow = inferRouterOutputs<AppRouter>['catalog']['agents'][number]
export type MeasuresResponse = inferRouterOutputs<AppRouter>['record']['measures']
