import type { AppRouter } from '../../../src/trpc/router.ts'
import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
})

const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/trpc' })],
})

export const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })

export type ProjectRow = inferRouterOutputs<AppRouter>['project']['list'][number]
export type DocRow = inferRouterOutputs<AppRouter>['doc']['list'][number]
export type DocSubjects = inferRouterOutputs<AppRouter>['doc']['subjects']
export type FlightResponse = inferRouterOutputs<AppRouter>['work']['flight']
export type BoardResponse = inferRouterOutputs<AppRouter>['work']['board']
export type DoneResponse = inferRouterOutputs<AppRouter>['work']['done']
export type SettingsResponse = inferRouterOutputs<AppRouter>['settings']['get']
export type TaskRecordResponse = inferRouterOutputs<AppRouter>['work']['task']
export type JobRow = inferRouterOutputs<AppRouter>['catalog']['jobs'][number]
export type AgentRow = inferRouterOutputs<AppRouter>['catalog']['agents'][number]
