// concern: record-api-write-routes
/** Composes the tenant-bound hosted write routes outside the main API surface. */

import type { Hono } from 'hono'
import { registerRecordBoardRoutes } from './record-api-board.ts'
import { registerRecordConfigAccessRoutes } from './record-api-config-access-routes.ts'
import { registerRecordDocCountsRoute } from './record-api-doc-counts.ts'
import { registerRecordDocOrderRoute } from './record-api-doc-order.ts'
import { registerRecordDocRenameRoute } from './record-api-doc-rename.ts'
import { registerRecordMachineKeyClaimRoutes } from './record-api-machine-key-claim-routes.ts'
import { registerRecordModerationRoutes } from './record-api-moderation-routes.ts'
import { registerRecordOutsideBlockRoutes } from './record-api-outside-block-routes.ts'
import { registerRecordOutsideIntakeRoutes } from './record-api-outside-intake-routes.ts'
import { registerRecordProjectRoutes } from './record-api-projects.ts'
import { registerRecordSettingsRoutes } from './record-api-settings.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
type Deps = Parameters<typeof registerRecordProjectRoutes>[1] & {
  renameDocSubject: Parameters<typeof registerRecordDocRenameRoute>[1]
} & Parameters<typeof registerRecordSettingsRoutes>[1] &
  Parameters<typeof registerRecordBoardRoutes>[1] &
  Parameters<typeof registerRecordMachineKeyClaimRoutes>[1] &
  Parameters<typeof registerRecordConfigAccessRoutes>[1] &
  Parameters<typeof registerRecordOutsideBlockRoutes>[1] &
  Parameters<typeof registerRecordModerationRoutes>[1] &
  Parameters<typeof registerRecordOutsideIntakeRoutes>[1] &
  Parameters<typeof registerRecordDocOrderRoute>[1] &
  Parameters<typeof registerRecordDocCountsRoute>[1]
type Ports = Parameters<typeof registerRecordProjectRoutes>[2] &
  Parameters<typeof registerRecordSettingsRoutes>[2] &
  Parameters<typeof registerRecordBoardRoutes>[2] &
  Parameters<typeof registerRecordMachineKeyClaimRoutes>[2] &
  Parameters<typeof registerRecordConfigAccessRoutes>[2] &
  Parameters<typeof registerRecordOutsideBlockRoutes>[2] &
  Parameters<typeof registerRecordModerationRoutes>[2] &
  Parameters<typeof registerRecordOutsideIntakeRoutes>[2] &
  Parameters<typeof registerRecordDocOrderRoute>[2] &
  Parameters<typeof registerRecordDocCountsRoute>[2]

export function registerRecordWriteRoutes(
  app: Hono<ApiEnvironment>,
  deps: Deps,
  ports: Ports,
): void {
  registerRecordProjectRoutes(app, deps, ports)
  registerRecordSettingsRoutes(app, deps, ports)
  registerRecordBoardRoutes(app, deps, ports)
  registerRecordMachineKeyClaimRoutes(app, deps, ports)
  registerRecordConfigAccessRoutes(app, deps, ports)
  registerRecordOutsideIntakeRoutes(app, deps, ports)
  registerRecordOutsideBlockRoutes(app, deps, ports)
  registerRecordModerationRoutes(app, deps, ports)
  registerRecordDocOrderRoute(app, deps, ports)
  registerRecordDocRenameRoute(app, deps.renameDocSubject, ports)
  registerRecordDocCountsRoute(app, deps, ports)
}
