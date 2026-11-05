// concern: record-api-read-routes
/** Composes the tenant-bound hosted read routes outside the main API surface. */

import { registerRecordReleaseRoutes } from './record-api-releases.ts'
import { registerRecordSubjectRoutes } from './record-api-subjects.ts'

type App = Parameters<typeof registerRecordSubjectRoutes>[0]
type Deps = Parameters<typeof registerRecordSubjectRoutes>[1] &
  Parameters<typeof registerRecordReleaseRoutes>[1]
type Ports = Parameters<typeof registerRecordSubjectRoutes>[2] &
  Parameters<typeof registerRecordReleaseRoutes>[2]

export function registerRecordReadRoutes(app: App, deps: Deps, ports: Ports): void {
  registerRecordSubjectRoutes(app, deps, ports)
  registerRecordReleaseRoutes(app, deps, ports)
}
