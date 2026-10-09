// concern: architecture-manifest
/** Confinement report module allowlists, kept outside the root manifest to preserve its ceiling. */
import { dirname, normalize } from 'node:path'

type ConfinementModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): ConfinementModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const confinementModules: ConfinementModule[] = [
  module('orchestrator/src/sandbox/record-connection-env.ts', []),
  module('orchestrator/src/sandbox/codex-sandbox.ts', []),
  module('orchestrator/src/sandbox/confinement-report.ts', [
    './codex-sandbox.ts',
    './record-connection-env.ts',
    './sandbox.ts',
  ]),
]
