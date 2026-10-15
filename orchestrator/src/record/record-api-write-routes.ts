// concern: record-api-write-routes
/** Composes the tenant-bound hosted write routes outside the main API surface. */

import type { Hono } from 'hono'
import { registerRecordBoardRoutes } from './record-api-board.ts'
import { registerRecordDocOrderRoute } from './record-api-doc-order.ts'
import { registerRecordProjectRoutes } from './record-api-projects.ts'
import { registerRecordSettingsRoutes } from './record-api-settings.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Deps = Parameters<typeof registerRecordProjectRoutes>[1] &
  Parameters<typeof registerRecordSettingsRoutes>[1] &
  Parameters<typeof registerRecordBoardRoutes>[1] &
  Parameters<typeof registerRecordDocOrderRoute>[1]
type Ports = Parameters<typeof registerRecordProjectRoutes>[2] &
  Parameters<typeof registerRecordSettingsRoutes>[2] &
  Parameters<typeof registerRecordBoardRoutes>[2] &
  Parameters<typeof registerRecordDocOrderRoute>[2]

export function registerRecordWriteRoutes(
  app: Hono<ApiEnvironment>,
  deps: Deps,
  ports: Ports,
): void {
  registerRecordProjectRoutes(app, deps, ports)
  registerRecordSettingsRoutes(app, deps, ports)
  registerRecordBoardRoutes(app, deps, ports)
  registerRecordDocOrderRoute(app, deps, ports)
}
