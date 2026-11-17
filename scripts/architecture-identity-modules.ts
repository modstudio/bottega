import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const identityModules = [
  module('orchestrator/src/identity/identity.ts', [
    'bun:sqlite',
    '../../../shared/identity-state-classes.ts',
    '../../../shared/reference.ts',
    '../project/project-read.ts',
    '../project-space.ts',
    '../question-store/question-store-read.ts',
  ]),
  module('orchestrator/src/identity/identity-context.ts', [
    'bun:sqlite',
    '../database/session-identity.ts',
    '../project/projects.ts',
    './identity.ts',
  ]),
  module('scripts/identity-typed-question-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-ruled-reference-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-undeclared-reference-manifest.ts', ['./identity-inventory.ts']),
]
