import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const typedQuestionModules = [
  module('scripts/identity-typed-question-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-ruled-reference-manifest.ts', ['./identity-inventory.ts']),
  module('scripts/identity-undeclared-reference-manifest.ts', ['./identity-inventory.ts']),
  module('shared/typed-question/registry.ts', []),
  module('shared/typed-question/client.ts', ['../env-source.ts', './registry.ts']),
  module('orchestrator/src/typed-question/typed-question-answer-store.ts', [
    'bun:sqlite',
    '../../../shared/record-id.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/typed-question/typed-question-service.ts', [
    'node:crypto',
    '../../../shared/typed-question/client.ts',
    '../../../shared/typed-question/registry.ts',
    './typed-question-answer-store.ts',
  ]),
]
