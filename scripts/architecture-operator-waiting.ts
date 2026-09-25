// concern: architecture-manifest
/** Operator-waiting and question-vocabulary module allowlists kept outside the root manifest. */
import { dirname, normalize } from 'node:path'

type OperatorWaitingModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): OperatorWaitingModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const operatorWaitingModules: OperatorWaitingModule[] = [
  module('orchestrator/src/run/question-vocabulary.ts', ['../../../shared/question-vocabulary.ts']),
  module('orchestrator/src/operator/operator-notification.ts', []),
  module('orchestrator/src/operator/operator-waiting.ts', [
    'bun:sqlite',
    '../../../shared/machine-config.ts',
    '../../../shared/operator-inbox.ts',
    '../database/db.ts',
    '../run/run-authority.ts',
    '../workflow/autonomy-scopes.ts',
    './operator-notification.ts',
  ]),
  module('orchestrator/src/operator/operator-commands.ts', [
    '../cli/args.ts',
    './operator-waiting.ts',
  ]),
  module('shared/question-vocabulary.ts', []),
  module('shared/operator-inbox.ts', []),
]
