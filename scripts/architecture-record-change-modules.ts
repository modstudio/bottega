// concern: architecture-manifest
/** Import allowlists for the hosted record change feed. */
import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordChangeModules = [
  module('orchestrator/src/record/record-api-client-changes.ts', [
    'zod',
    './record-api-client-paths.ts',
  ]),
  module('orchestrator/src/record/record-cache-feed.ts', [
    'bun:sqlite',
    '../../../shared/record-space-membership.ts',
    '../database/db.ts',
    '../project-space.ts',
    '../project/projects.ts',
    '../subject/subjects.ts',
    './record-api-client.ts',
    './record-api-client-changes.ts',
    './record-auth.ts',
    './record-cache-lens.ts',
    './record-cache-cursor.ts',
    './record-cache-ownership.ts',
    './record-cache-port.ts',
    './record-cache-projects.ts',
    './record-cache-workflow.ts',
    './record-lens-contract.ts',
    './record-port-contract.ts',
    './record-project-destination.ts',
    './record-routing-evidence-contract.ts',
    './record-routing-pool.ts',
    './record-session.ts',
    './record-workflow-contract.ts',
  ]),
  module('orchestrator/src/record/record-api-changes.ts', [
    'hono',
    'zod',
    '../../../shared/record/record-changes.ts',
    './record-auth.ts',
    './record-change-feed.ts',
  ]),
  module('orchestrator/src/record/record-change-wake.ts', [
    'bun',
    '../../../shared/record/service-connection.ts',
  ]),
  module('orchestrator/src/record/record-change-feed.ts', [
    'bun',
    '../../../shared/record/record-changes.ts',
    '../../../shared/record/tenant.ts',
    './record-lens-contract.ts',
    './record-port-contract.ts',
    './record-workflow-contract.ts',
    './record-doc-mapping.ts',
    './record-doc-read.ts',
    './record-lens-catalogue.ts',
    './record-port-catalogue.ts',
    './record-projects.ts',
    './record-pool.ts',
    './record-routing-evidence.ts',
    './record-subjects.ts',
    './record-verdicts.ts',
    './record-workflow-catalogue.ts',
  ]),
]
