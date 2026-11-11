// concern: hosted-route-config
/** Shared configuration contract for hosted REST adapters. */

import type { SQL } from 'bun'
import type { NoDestinationWriteCounter } from '../../shared/record-no-destination-write-counter.ts'

export type HostedRouteConfig = {
  recordApiUrl: string
  recordDatabaseUrl: SQL
  noDestinationWriteCounter: NoDestinationWriteCounter
}
