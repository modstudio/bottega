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
  module('orchestrator/src/operator/operator-waiting.ts', [
    'bun:sqlite',
    '../../../shared/machine-config.ts',
    '../../../shared/orch-contract.ts',
    '../../../shared/operator-inbox.ts',
    '../../../shared/operator-notification.ts',
    '../database/db.ts',
    '../run/run-authority.ts',
    '../workflow/autonomy-scopes.ts',
  ]),
  module('orchestrator/src/operator/operator-commands.ts', [
    '../../../shared/orch-contract.ts',
    '../cli/args.ts',
    './operator-waiting.ts',
  ]),
  module('shared/question-vocabulary.ts', []),
  module('shared/operator-inbox.ts', []),
  module('shared/operator-notification-contract.ts', []),
  module('shared/operator-notification.ts', ['./operator-notification-contract.ts']),
  module('hub/src/operator-waiting-email.ts', [
    '../../shared/machine-config.ts',
    '../../shared/operator-inbox.ts',
    '../../shared/orch-contract.ts',
    './db.ts',
    './orch.ts',
    './sync.ts',
    './task-client.ts',
  ]),
  module('hub/src/operator-waiting-email-hosted.ts', [
    'bun',
    '../../shared/record/schema.ts',
    './hosted-tasks.ts',
    './operator-waiting-email-contract.ts',
    './report-delivery.ts',
    './report-delivery-hosted.ts',
  ]),
  module('hub/src/operator-waiting-email-contract.ts', ['zod']),
  module('hub/src/operator-waiting-email-api.ts', [
    './operator-waiting-email-contract.ts',
    './operator-waiting-email-hosted.ts',
    './report-delivery.ts',
    './report-delivery-hosted.ts',
  ]),
]
