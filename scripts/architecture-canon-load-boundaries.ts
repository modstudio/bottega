import { dirname, normalize } from 'node:path'
import type { ImportBoundary } from './architecture-boundaries.ts'

const boundary = (
  name: string,
  file: string,
  allowed: string[],
  reason: string,
): ImportBoundary => ({
  name,
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
  typeOnlyAllowed: [],
  reason,
})

export const canonLoadBoundarySpecs: ImportBoundary[] = [
  boundary(
    'canon-load-boundary',
    'orchestrator/src/canon/canon-load.ts',
    ['node:path'],
    'Keep harness load planning pure and independent of filesystems, stores, commands, and processes.',
  ),
  boundary(
    'canon-load-files-boundary',
    'orchestrator/src/canon/canon-load-files.ts',
    ['node:fs', 'node:path', './canon-files.ts', './canon-load.ts'],
    'Keep harness load file collection independent of stores, commands, runs, routing, and worktrees.',
  ),
]
