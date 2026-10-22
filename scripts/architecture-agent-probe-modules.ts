import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const agentProbeModules = [
  module('orchestrator/src/agent/endpoint-api-key.ts', [
    '../../../shared/brand.ts',
    '../../../shared/env-source.ts',
    '../../../shared/secret-resolution-failure.ts',
  ]),
  module('orchestrator/src/agent/agent-probe.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    './agent-registry.ts',
    './endpoint-api-key.ts',
    './agents.ts',
    './capabilities.ts',
    '../database/db.ts',
    '../jobs/jobs.ts',
    './model-host.ts',
    '../mcp/mcp-probe.ts',
    '../run/run-number.ts',
    '../transport/transport.ts',
  ]),
]
