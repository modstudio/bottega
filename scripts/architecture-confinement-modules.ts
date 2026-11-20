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
  module('orchestrator/src/sandbox/sandbox-runtime.ts', [
    'node:fs',
    'node:path',
    '@anthropic-ai/sandbox-runtime',
    '../../../shared/embedded-assets.ts',
    '../../../shared/sandbox-runtime-assets.ts',
    '../../../shared/state-directory.ts',
    '../../../shared/bounded-process.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/transport/sandbox-readiness.ts', [
    '../../../shared/brand.ts',
    '../sandbox/sandbox-runtime.ts',
  ]),
  module('orchestrator/src/sandbox/record-connection-env.ts', []),
  module('orchestrator/src/sandbox/codex-sandbox.ts', []),
  module('orchestrator/src/sandbox/weaker-network-isolation.ts', ['node:net']),
  module('orchestrator/src/sandbox/area-read-policy.ts', [
    'node:path',
    '../../../shared/state-directory.ts',
    '../project/projects.ts',
    '../run-owned-paths.ts',
  ]),
  module('orchestrator/src/sandbox/install-read-policy.ts', [
    'node:fs',
    'node:path',
    '../../../shared/config-directory.ts',
    '../../../shared/install-root.ts',
  ]),
  module('orchestrator/src/sandbox/worker-sandbox-environment.ts', [
    '../../../shared/config-directory.ts',
    '../../../shared/state-directory.ts',
  ]),
  module('orchestrator/src/sandbox/sandbox.ts', [
    '../../../shared/brand.ts',
    '../../../shared/file-backed-secret-paths.ts',
    '../../../shared/refusal.ts',
    '../../../shared/self-spawn.ts',
    '../../../shared/config-directory.ts',
    '../../../shared/state-directory.ts',
    '../mcp/mcp-probe.ts',
    '../no-follow-file.ts',
    '../project/projects.ts',
    '../resources/main-stack-network.ts',
    '../run-owned-paths.ts',
    './area-read-policy.ts',
    './install-read-policy.ts',
    './node-module-read-carvebacks.ts',
    './sandbox-area-read-profile.ts',
    './sandbox-runtime.ts',
    './weaker-network-isolation.ts',
  ]),
  module('orchestrator/src/sandbox/sandbox-area-read-profile.ts', ['./area-read-policy.ts']),
  module('orchestrator/src/sandbox/node-module-read-carvebacks.ts', [
    'node:fs',
    'node:path',
    './area-read-policy.ts',
  ]),
  module('orchestrator/src/sandbox/confinement-report.ts', [
    './codex-sandbox.ts',
    './record-connection-env.ts',
    './sandbox.ts',
  ]),
  module('orchestrator/src/sandbox/confinement-run-measurement.ts', [
    '../run/run-confinement-count.ts',
  ]),
  module('orchestrator/src/sandbox/confinement-filesystem-probe.ts', [
    'bun:sqlite',
    'node:fs',
    'node:os',
    'node:path',
    '../../../shared/brand.ts',
    '../../../shared/bounded-process.ts',
    '../../../shared/config-directory.ts',
    '../../../shared/install-root.ts',
    '../../../shared/self-spawn.ts',
    '../../../shared/state-directory.ts',
    '../../../shared/store-access.ts',
    '../agent/agents.ts',
    '../project/projects.ts',
    '../run/run-worker-home.ts',
    './install-read-policy.ts',
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
    'orchestrator/src/run/run-outbox.ts',
    'orchestrator/src/run/run-root-rollup.ts',
    'shared/bounded-process.ts',
  ],
  typeOnlyAllowed: [],
  reason:
    'Keep confinement rulings independent of transports, routing, reviews, contracts, the CLI, and durable execution.',
}
