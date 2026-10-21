// concern: architecture-manifest
/** Worker-gate module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type GateModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): GateModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const gateModules: GateModule[] = [
  module('orchestrator/src/gate/gate-decision.ts', []),
  module('orchestrator/src/gate/gate-broker.ts', [
    '../../../shared/check-execution.ts',
    'node:child_process',
    'node:fs',
    'node:path',
    '../database/db.ts',
    '../gate-load.ts',
    '../idle-kill.ts',
    '../issue/issue-shell.ts',
    '../no-follow-file.ts',
    '../project/project-settings.ts',
    '../review/review-target.ts',
    '../resources/main-stack.ts',
    '../run/run-artifacts.ts',
    '../run/run-child-priority.ts',
    './gate-check-executions.ts',
    './gate-decision.ts',
    './host-slot-wait.ts',
  ]),
  module('orchestrator/src/gate/host-slot-wait.ts', [
    '../database/db.ts',
    '../events.ts',
    '../gate-load.ts',
  ]),
  module('orchestrator/src/gate/gate-run.ts', [
    '../../../shared/brand.ts',
    'bun:sqlite',
    'node:child_process',
    '../../../shared/check-execution.ts',
    '../../../shared/record-id.ts',
    '../../../shared/git.ts',
    '../../../shared/secret-shaped.ts',
    '../caller-classification.ts',
    '../database/db.ts',
    '../project/projects.ts',
    '../resources/main-stack.ts',
    './gate-check-executions.ts',
    './gate-decision.ts',
  ]),
  module('orchestrator/src/gate/gate-check-executions.ts', [
    '../../../shared/check-execution.ts',
    '../../../shared/record-id.ts',
    '../../../shared/state-directory.ts',
    'bun:sqlite',
    'node:fs',
    'node:path',
  ]),
  module('orchestrator/src/gate/gate-passed.ts', [
    '../../../shared/brand.ts',
    'bun:sqlite',
    '../database/db.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/gate/gate-result.ts', [
    '../../../shared/brand.ts',
    '../database/db.ts',
    '../project/projects.ts',
  ]),
]
