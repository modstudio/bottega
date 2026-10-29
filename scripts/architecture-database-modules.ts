import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const databaseModules: ArchitectureModule[] = [
  module('orchestrator/src/database/slow-statements.ts', ['bun:sqlite']),
  module('orchestrator/src/database/migration-drain-state.ts', [
    'bun:sqlite',
    '../../../shared/process-identity.ts',
  ]),
  module('orchestrator/src/database/migration-window-decision.ts', []),
  module('orchestrator/src/database/migration-window-state.ts', [
    'bun:sqlite',
    '../../../shared/process-identity.ts',
  ]),
  module('orchestrator/src/database/migration-window.ts', [
    'bun:sqlite',
    '../../../shared/process-identity.ts',
    './db.ts',
    './migration-window-decision.ts',
    './migration-window-state.ts',
  ]),
  module('orchestrator/src/database/workflow-uuid-migration-preflight.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../project-space.ts',
    '../record/install-binding.ts',
  ]),
  module('orchestrator/src/database/run-filesystem-identity.ts', [
    'bun:sqlite',
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../filesystem-identity-plan.ts',
    '../resources/ref-guard.ts',
    '../resources/resource-inventory.ts',
    '../run/run-artifacts.ts',
    '../run/run-coordinator-log.ts',
    '../run/run-lease.ts',
    '../worktree/worktree-attribution.ts',
    './database-location.ts',
  ]),
  module('orchestrator/src/database/project-register-store.ts', [
    'bun:sqlite',
    'node:fs',
    'node:path',
    '../../../shared/record-id.ts',
    '../../../shared/state-directory.ts',
    '../project/project-settings.ts',
  ]),
  module('orchestrator/src/database/store-actor.ts', ['node:os', 'node:path']),
  module('orchestrator/src/database/wal-persistence.ts', ['bun:sqlite']),
  module('orchestrator/src/database/machine-identity-store.ts', [
    'bun:sqlite',
    '../../../shared/config-directory.ts',
    '../../../shared/machine-config.ts',
  ]),
  module('orchestrator/src/runtime/store-hooks.ts', [
    '../database/db.ts',
    '../evidence/evidence-query.ts',
    '../lens/lens-seeds.ts',
    '../review/review-round-backfill.ts',
    '../run/run-liveness.ts',
    '../run/shared-git-config-run.ts',
    '../workflow/workflow-seeds.ts',
  ]),
]
