// concern: architecture-manifest
/** Spare-hands lane allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type SpareModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): SpareModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const spareModules: SpareModule[] = [
  module('orchestrator/src/spare/spare-decisions.ts', ['../failure/failure.ts']),
  module('orchestrator/src/spare/spare-runner.ts', [
    'node:fs',
    '../../../shared/brand.ts',
    '../../../shared/git.ts',
    '../../../shared/machine-config.ts',
    '../../../shared/self-spawn.ts',
    '../agent/agent-registry.ts',
    '../database/db.ts',
    '../doc/doc-list.ts',
    '../doc/docs.ts',
    '../mcp/hub-notes.ts',
    '../project/projects.ts',
    './spare-decisions.ts',
  ]),
]
