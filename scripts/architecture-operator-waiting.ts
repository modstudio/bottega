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
  module('orchestrator/src/run/question-mutation.ts', [
    'bun:sqlite',
    '../caller-classification.ts',
    '../database/db.ts',
    './run-mutation-owner.ts',
  ]),
  module('orchestrator/src/run/question-ruling-remedy.ts', []),
  module('orchestrator/src/run/run-mutation-owner.ts', ['../cleanup/cleanup-sweep-decisions.ts']),
  module('orchestrator/src/run/ruling-file-authority.ts', [
    '../../../shared/question-vocabulary.ts',
    './run-answer-authority.ts',
    './run-mutation-owner.ts',
  ]),
  module('orchestrator/src/run/ruling-file-text.ts', []),
  module('orchestrator/src/run/ruling-list.ts', [
    '../../../shared/orch-contract.ts',
    '../database/db.ts',
    './question-open.ts',
  ]),
  module('orchestrator/src/run/ruling-overturn-authority.ts', []),
  module('orchestrator/src/run/ruling-overturn.ts', [
    '../database/db.ts',
    './question-vocabulary.ts',
    './question-mutation.ts',
    './question-outbox.ts',
    './ruling-overturn-authority.ts',
    './run-authority.ts',
  ]),
  module('orchestrator/src/run/ruling-file.ts', [
    '../../../shared/docs.ts',
    '../../../shared/question-vocabulary.ts',
    '../caller-classification.ts',
    '../dashboard-capability.ts',
    '../database/db.ts',
    './question-mutation.ts',
    './question-outbox.ts',
    './question-ruling-remedy.ts',
    './question-vocabulary.ts',
    './ruling-file-authority.ts',
    './ruling-file-text.ts',
    './run-authority.ts',
    './run-mutation-owner.ts',
  ]),
  module('orchestrator/src/operator/operator-waiting.ts', [
    'bun:sqlite',
    '../../../shared/machine-config.ts',
    '../../../shared/orch-contract.ts',
    '../../../shared/operator-inbox.ts',
    '../../../shared/operator-notification.ts',
    '../database/db.ts',
    '../run/run-authority.ts',
    '../run/question-outbox.ts',
    '../run/question-open.ts',
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
    '../../shared/record-space-membership.ts',
    '../../shared/record-space-request.ts',
    './operator-waiting-email-contract.ts',
    './operator-waiting-email-hosted.ts',
    './report-delivery.ts',
    './report-delivery-hosted.ts',
  ]),
]
