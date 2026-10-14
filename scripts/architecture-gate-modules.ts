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
    'node:child_process',
    'node:fs',
    'node:path',
    '../database/db.ts',
    '../idle-kill.ts',
    '../issue/issue-shell.ts',
    '../project/project-settings.ts',
    '../review/review-target.ts',
    '../resources/main-stack.ts',
    '../run/run-artifacts.ts',
    './gate-decision.ts',
  ]),
  module('orchestrator/src/gate/gate-run.ts', [
    '../../../shared/brand.ts',
    'bun:sqlite',
    'node:child_process',
    'node:fs',
    'node:path',
    '../../../shared/check-execution.ts',
    '../../../shared/record-id.ts',
    '../../../shared/git.ts',
    '../../../shared/secret-shaped.ts',
    '../../../shared/state-directory.ts',
    '../caller-classification.ts',
    '../database/db.ts',
    '../project/projects.ts',
    '../resources/main-stack.ts',
    './gate-decision.ts',
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
