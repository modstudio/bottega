import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordMigrationModules = [
  module('orchestrator/src/postgres/migration-failure.ts', []),
  module('orchestrator/src/postgres/migration-notices.ts', []),
  module('orchestrator/src/postgres/postgres-migrate.ts', [
    '../../../shared/install-root.ts',
    '../../../shared/record/migration-session.ts',
  ]),
]
