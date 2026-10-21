// concern: hosted-route-config
/** Shared configuration contract for hosted REST adapters. */

import type { SQL } from 'bun'

export type HostedRouteConfig = {
  recordApiUrl: string
  recordDatabaseUrl: SQL
}
