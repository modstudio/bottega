// concern: architecture-manifest
/** Session-loss measurement allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

type SessionLossesModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): SessionLossesModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const sessionLossesModules: SessionLossesModule[] = [
  module('orchestrator/src/session-losses/session-losses.ts', [
    '../../../shared/brand.ts',
    '../../../shared/command-spellings.ts',
    '../mcp/mcp-board-claim-tools.ts',
    '../metric/transcript-reader.ts',
  ]),
  module('orchestrator/src/session-losses/session-losses-adapter.ts', [
    'node:fs',
    'node:path',
    '../../../shared/brand.ts',
    '../../../shared/machine-config.ts',
    '../../../shared/state-directory.ts',
    '../cleanup/cleanup-sweep-decisions.ts',
    '../contract/contract.ts',
    '../database/db.ts',
    '../doc/docs.ts',
    '../metric/transcript-reader.ts',
    '../run/run-artifacts.ts',
    '../run/run-dispatch.ts',
    '../run/run-status.ts',
    './session-losses.ts',
  ]),
  module('orchestrator/src/session-losses/session-losses-format.ts', [
    './session-losses-adapter.ts',
  ]),
]
