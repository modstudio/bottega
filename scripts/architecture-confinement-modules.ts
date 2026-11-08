// concern: architecture-manifest
/** Sandbox and confinement module allowlists, kept outside the root manifest to preserve its ceiling. */
import { dirname, normalize } from 'node:path'

type ConfinementModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): ConfinementModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const confinementModules: ConfinementModule[] = [
  module('orchestrator/src/sandbox/record-connection-env.ts', []),
  module('orchestrator/src/sandbox/codex-sandbox.ts', []),
  module('orchestrator/src/sandbox/weaker-network-isolation.ts', ['node:net']),
  module('orchestrator/src/sandbox/sandbox.ts', [
    '../../../shared/brand.ts',
    '../../../shared/embedded-assets.ts',
    '../../../shared/file-backed-secret-paths.ts',
    '../../../shared/self-spawn.ts',
    '../../../shared/config-directory.ts',
    '../../../shared/state-directory.ts',
    '../database/db.ts',
    '../mcp/mcp-probe.ts',
    '../no-follow-file.ts',
    '../project/projects.ts',
    '../resources/main-stack-network.ts',
    '../run-owned-paths.ts',
    './sandbox-runtime.ts',
    './weaker-network-isolation.ts',
  ]),
  module('orchestrator/src/sandbox/confinement-report.ts', [
    './codex-sandbox.ts',
    './record-connection-env.ts',
    './sandbox.ts',
  ]),
]

export const confinementRulingBoundary = {
  name: 'confinement-ruling-boundary',
  file: 'orchestrator/src/confinement/confinement-ruling.ts',
  allowed: [
    'node:fs',
    'orchestrator/src/confinement/confinement.ts',
    'orchestrator/src/database/db.ts',
    'orchestrator/src/git/git-environment.ts',
    'orchestrator/src/project/projects.ts',
    'orchestrator/src/record/machine-identity.ts',
    'orchestrator/src/run/run-authority.ts',
    'orchestrator/src/run/run-liveness.ts',
    'orchestrator/src/run/run-outbox.ts',
    'shared/bounded-process.ts',
  ],
  typeOnlyAllowed: [],
  reason:
    'Keep confinement rulings independent of transports, routing, reviews, contracts, the CLI, and durable execution.',
}
