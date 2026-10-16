import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const databaseModules: ArchitectureModule[] = [
  module('orchestrator/src/database/project-register-store.ts', [
    'bun:sqlite',
    'node:fs',
    'node:path',
    '../../../shared/record-id.ts',
    '../../../shared/state-directory.ts',
    '../project/project-settings.ts',
  ]),
  module('orchestrator/src/database/machine-identity-store.ts', [
    'bun:sqlite',
    '../../../shared/config-directory.ts',
    '../../../shared/machine-config.ts',
  ]),
  module('orchestrator/src/database/identity-inventory.ts', ['bun:sqlite']),
  module('orchestrator/src/database/identity-key-manifest.ts', ['./identity-inventory.ts']),
]
