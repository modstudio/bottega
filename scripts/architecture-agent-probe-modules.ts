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
    '../../../shared/config-directory.ts',
    '../../../shared/record-id.ts',
    './agent-registry.ts',
    './agents.ts',
    './capabilities.ts',
    '../database/db.ts',
    '../jobs/jobs.ts',
    './model-host.ts',
    '../mcp/mcp-probe.ts',
    '../run/run-number.ts',
    '../transport/transport.ts',
    './agent-writing-probe.ts',
    './agent-probe-turn.ts',
  ]),
  module('orchestrator/src/agent/agent-writing-probe.ts', [
    '../../../shared/config-directory.ts',
    '../../../shared/git.ts',
    './agents.ts',
    '../project/projects.ts',
    '../sandbox/sandbox.ts',
  ]),
  module('orchestrator/src/agent/agent-probe-turn.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../run/run-number.ts',
    '../transport/transport.ts',
    './agents.ts',
    './endpoint-api-key.ts',
    './agent-writing-probe.ts',
  ]),
]
