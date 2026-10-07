import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { AppRouter, HostedRouter } from '../../../src/trpc/router.ts'
import { hostedOrigin, isHostedMode, unauthorizedLeadsToSignIn } from '../lib/hub-mode.ts'
import { toast } from '../ui/toast/toast.tsx'
import { fetchWithHubCredentials } from './transport.ts'

const LOCAL_LOGIN_MESSAGE = 'Your local session expired. Run `hub login` to sign in again.'

function isUnauthorized(error: unknown) {
  return error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED'
}

function redirectToSignIn() {
  if (!isHostedMode()) return
  const path = window.location.pathname
  if (!unauthorizedLeadsToSignIn(path, hostedOrigin().kind)) return
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

const links = [
  httpBatchLink({
    url: '/trpc',
    fetch(url, options) {
      return fetchWithHubCredentials(
        fetch,
        isHostedMode(),
        () => toast.error(LOCAL_LOGIN_MESSAGE),
        url,
        (options ?? {}) as RequestInit,
      )
    },
  }),
]

const client = createTRPCClient<AppRouter>({ links })

export const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })

/** The hosted server mounts a different router; use this proxy only in hosted mode. */
export const hostedTrpc = createTRPCOptionsProxy<HostedRouter>({
  client: createTRPCClient<HostedRouter>({ links }),
  queryClient,
})

export type ProjectRow = inferRouterOutputs<AppRouter>['project']['list'][number]
export type HostedProjectRow = inferRouterOutputs<AppRouter>['record']['projects'][number]
export type FlightResponse = inferRouterOutputs<AppRouter>['work']['flight']
export type BoardResponse = inferRouterOutputs<AppRouter>['work']['board']
export type RecordSettingsResponse = inferRouterOutputs<AppRouter>['record']['settings']
export type TaskRecordResponse = inferRouterOutputs<AppRouter>['work']['task']
export type JobRow = inferRouterOutputs<AppRouter>['catalog']['jobs'][number]
export type AgentRow = inferRouterOutputs<AppRouter>['catalog']['agents'][number]
export type OperatorWaitingItem = inferRouterOutputs<AppRouter>['operator']['waiting'][number]
export type MeasuresResponse = inferRouterOutputs<AppRouter>['record']['measures']
