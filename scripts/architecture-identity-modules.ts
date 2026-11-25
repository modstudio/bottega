import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const identityModules = [
  module('orchestrator/src/identity/board-message-identity.ts', [
    'bun:sqlite',
    '../../../shared/record-id.ts',
  ]),
  module('orchestrator/src/identity/doc-revision-identity.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../record/record-read-authority.ts',
  ]),
  module('hub/src/identity/identity.ts', [
    'bun:sqlite',
    '../../../shared/reference-refusal.ts',
    '../../../shared/reference.ts',
  ]),
  module('hub/src/identity/note-reference.ts', ['../../../shared/note-label.ts']),
  module('hub/src/identity/hosted-identity.ts', ['bun']),
  module('orchestrator/src/identity/identity.ts', [
    'bun:sqlite',
    '../../../shared/identity-state-classes.ts',
    '../../../shared/reference-refusal.ts',
    '../../../shared/reference.ts',
    '../project/project-read.ts',
    '../project-space-cache.ts',
    '../question-store/question-store-read.ts',
    '../record/machine-name.ts',
    './identity-local-run.ts',
  ]),
  module('orchestrator/src/identity/identity-local-run.ts', [
    'bun:sqlite',
    '../../../shared/reference-refusal.ts',
  ]),
  module('orchestrator/src/identity/identity-context.ts', [
    'bun:sqlite',
    '../../../shared/machine-config.ts',
    '../database/session-identity.ts',
    '../project/projects.ts',
    './identity.ts',
  ]),
  module('scripts/identity-typed-question-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-ruled-reference-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-undeclared-reference-manifest.ts', ['./identity-inventory.ts']),
]
