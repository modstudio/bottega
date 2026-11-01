// concern: record-api-session-routes
/** Composes authenticated record routes that do not use the active-space scope helper. */

import type { Hono } from 'hono'
import {
  type RecordInvitationRouteDeps,
  registerRecordInvitationRoute,
} from './record-api-invitations.ts'
import { type RecordMachineRouteDeps, registerRecordMachineRoutes } from './record-api-machine.ts'
import {
  type RoutingEvidenceRouteDeps,
  registerRecordRoutingEvidenceRoute,
} from './record-api-routing-evidence.ts'
import { type RecordSyncRouteDeps, registerRecordSyncRoute } from './record-api-sync.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
export type RecordSessionRouteDeps = RecordMachineRouteDeps &
  RecordInvitationRouteDeps &
  RecordSyncRouteDeps &
  RoutingEvidenceRouteDeps

export function registerRecordSessionRoutes(
  app: Hono<ApiEnvironment>,
  deps: RecordSessionRouteDeps,
): void {
  registerRecordMachineRoutes(app, deps)
  registerRecordInvitationRoute(app, deps)
  registerRecordSyncRoute(app, deps)
  registerRecordRoutingEvidenceRoute(app, deps)
}
