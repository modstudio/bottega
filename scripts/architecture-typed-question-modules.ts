import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const typedQuestionModules = [
  module('orchestrator/src/run/prompt-sha.ts', ['node:crypto']),
  module('shared/typed-question/registry.ts', []),
  module('shared/typed-question/client.ts', ['../env-source.ts', './registry.ts']),
  module('orchestrator/src/typed-question/typed-question-answer-store.ts', [
    'bun:sqlite',
    '../../../shared/record-id.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/typed-question/spec-unsettled-question.ts', [
    '../../../shared/typed-question/registry.ts',
  ]),
  module('orchestrator/src/typed-question/typed-question-metrics.ts', []),
  module('orchestrator/src/typed-question/typed-question-report.ts', [
    'bun:sqlite',
    '../../../shared/typed-question/client.ts',
    '../database/db.ts',
    '../run/run-status.ts',
    './spec-unsettled-question.ts',
    './typed-question-metrics.ts',
  ]),
  module('orchestrator/src/typed-question/typed-question-commands.ts', [
    '../../../shared/brand.ts',
    './typed-question-report.ts',
  ]),
  module('orchestrator/src/typed-question/typed-question-service.ts', [
    'node:crypto',
    '../../../shared/typed-question/client.ts',
    '../../../shared/typed-question/registry.ts',
    './typed-question-answer-store.ts',
  ]),
]
