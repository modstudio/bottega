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
    '../run/run-artifacts.ts',
    './gate-decision.ts',
  ]),
  module('orchestrator/src/gate/gate-run.ts', [
    'bun:sqlite',
    'node:child_process',
    '../../../shared/secret-shaped.ts',
    '../database/db.ts',
    '../project/projects.ts',
    './gate-decision.ts',
  ]),
]
