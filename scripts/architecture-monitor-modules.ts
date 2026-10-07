// concern: architecture-manifest
/** Monitor module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type MonitorModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): MonitorModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const monitorModules: MonitorModule[] = [
  module('orchestrator/src/monitor/monitor-gate-tooling.ts', [
    'bun:sqlite',
    '../branch/offline-branch-landing.ts',
    '../database/db.ts',
    './monitor-types.ts',
  ]),
  module('orchestrator/src/monitor/monitor.ts', [
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../canon/canon.ts',
    '../board/board-service.ts',
    '../database/db.ts',
    '../resources/docker-resources.ts',
    '../resources/git-locks.ts',
    '../worktree/keep-tree-hold.ts',
    '../mcp/mcp.ts',
    './monitor-conditions.ts',
    './monitor-branches.ts',
    './monitor-gate-tooling.ts',
    './monitor-record-tunnel.ts',
    './monitor-retrieval-pins.ts',
    './monitor-stray-worktrees.ts',
    './monitor-harness-load.ts',
    './monitor-canon-drift.ts',
    './monitor-notices.ts',
    './monitor-outbox.ts',
    './monitor-types.ts',
    '../../../shared/process-identity.ts',
    '../project/project-lock.ts',
    '../project/projects.ts',
    '../recipe/database-connection-observation.ts',
    '../recipe/database-inventory.ts',
    '../reclaim/reclaim.ts',
    '../sandbox/grok-trust.ts',
    '../idle-kill.ts',
    '../resources/resource-ownership.ts',
    '../review/review-vocabulary.ts',
    '../run/run-artifacts.ts',
    '../worktree/worktree-attribution.ts',
    './database-connection-conditions.ts',
  ]),
  module('orchestrator/src/monitor/database-connection-conditions.ts', [
    '../recipe/database-connection.ts',
    './monitor-types.ts',
  ]),
  module('orchestrator/src/monitor/monitor-branches.ts', []),
  module('orchestrator/src/monitor/monitor-harness-load.ts', [
    '../canon/canon-load.ts',
    '../canon/canon-load-files.ts',
    '../project/projects.ts',
    './monitor-types.ts',
  ]),
  module('orchestrator/src/monitor/monitor-canon-drift.ts', [
    '../canon/canon-files.ts',
    '../canon/canon-hydrate.ts',
    '../canon/canon-stored-rows.ts',
    '../project/projects.ts',
    './monitor-types.ts',
  ]),
  module('orchestrator/src/monitor/monitor-retrieval-pins.ts', [
    '../../../shared/self-spawn.ts',
    './monitor-types.ts',
  ]),
  module('orchestrator/src/monitor/monitor-store-write-lock.ts', [
    '../database/db.ts',
    '../database/store-write-lock.ts',
  ]),
  module('orchestrator/src/monitor/monitor-outbox.ts', [
    'bun:sqlite',
    '../record/outbox-dependency.ts',
    '../record/outbox-quarantine.ts',
    './monitor-types.ts',
  ]),
]
