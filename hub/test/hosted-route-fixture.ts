import type { SQL } from 'bun'
import type { HostedRouteConfig } from '../src/hosted-route-config.ts'

const unusedDatabase = (() => {
  throw new Error('hosted route database double was unexpectedly queried')
}) as unknown as SQL

export const hostedRouteTestConfig = {
  recordApiUrl: 'https://record.example.test',
  recordDatabaseUrl: unusedDatabase,
} satisfies HostedRouteConfig
