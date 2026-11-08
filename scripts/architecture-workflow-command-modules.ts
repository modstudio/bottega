// concern: architecture-manifest
/** Workflow command module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type WorkflowCommandModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): WorkflowCommandModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const workflowCommandModules: WorkflowCommandModule[] = [
  module('orchestrator/src/workflow/task-flow-decision.ts', []),
  module('orchestrator/src/workflow/task-flow-read-through.ts', [
    'bun:sqlite',
    '../../../shared/record-api-url.ts',
    '../../../shared/record-remedies.ts',
    '../database/db.ts',
    '../record/record-api-client.ts',
    '../record/record-task-flow-contract.ts',
    './task-flow-decision.ts',
    './task-flow.ts',
  ]),
  module('orchestrator/src/workflow/task-flow.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../record/machine-identity.ts',
    './task-flow-decision.ts',
    './task-flow-outbox.ts',
    './task-flow-stage-outbox.ts',
  ]),
  module('orchestrator/src/workflow/task-flow-outbox.ts', [
    'bun:sqlite',
    '../../../shared/record/schema.ts',
    '../database/db.ts',
    '../record/machine-identity.ts',
    './task-flow-outbox-write.ts',
  ]),
  module('orchestrator/src/workflow/task-flow-stage-outbox.ts', [
    'bun:sqlite',
    '../../../shared/record/schema.ts',
    '../database/db.ts',
    '../record/machine-identity.ts',
    './task-flow-outbox-write.ts',
  ]),
  module('orchestrator/src/workflow/task-flow-outbox-write.ts', [
    'bun:sqlite',
    '../../../shared/record-id.ts',
    '../record/outbox-enqueue.ts',
    '../record/outbox-sanitize.ts',
  ]),
  module('orchestrator/src/workflow/workflow-cursor-identity.ts', [
    'bun:sqlite',
    '../../../shared/orch-contract.ts',
    '../database/db.ts',
  ]),
  module('orchestrator/src/workflow/workflow-cursor-command-target.ts', [
    'bun:sqlite',
    '../cli/args.ts',
    '../database/db.ts',
    './workflow-cursor-selection.ts',
  ]),
  module('orchestrator/src/workflow/workflow-compose-branch.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/workflow/workflow-exec-checkout.ts', ['../../../shared/brand.ts']),
  module('orchestrator/src/workflow/workflow-catalogue-commands.ts', [
    'node:path',
    '../cli/args.ts',
    '../project/projects.ts',
    './step-catalogue.ts',
    './workflow-commands.ts',
  ]),
]
