import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordSpaceAgentModules = [
  module('orchestrator/src/postgres/migration-failure.ts', []),
  module('orchestrator/src/postgres/migration-notices.ts', []),
  module('orchestrator/src/record/record-space-agents.ts', [
    'bun',
    '../../../shared/hosted-secret-mask.ts',
    '../../../shared/record/tenant.ts',
    '../../../shared/record-id.ts',
    './record-pool.ts',
  ]),
  module('orchestrator/src/record/record-api-client-space-agents.ts', [
    './record-api-client-paths.ts',
    './record-space-agents.ts',
  ]),
  module('orchestrator/src/record/record-api-space-agents.ts', [
    'hono',
    'zod',
    './record-api-client-paths.ts',
    './record-auth.ts',
    './record-space-agents.ts',
  ]),
]
