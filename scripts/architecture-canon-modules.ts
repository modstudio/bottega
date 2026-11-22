// concern: architecture-manifest
/** Canon module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'
import { canonMirrorDecisionBoundarySpecs } from './architecture-canon-boundaries.ts'

type CanonModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): CanonModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const canonModules: CanonModule[] = [
  ...canonMirrorDecisionBoundarySpecs.map((spec) =>
    module(spec.file, [...spec.allowed, ...spec.typeOnlyAllowed]),
  ),
  module('orchestrator/src/canon/pack-content.ts', [
    '../../../shared/canon-frontmatter.ts',
    './canon-hydrate.ts',
    './canon-lint.ts',
  ]),
  module('orchestrator/src/doc/canon-removal.ts', [
    '../canon/canon-files.ts',
    '../canon/canon-hydrate.ts',
    '../canon/canon-write-gate.ts',
    '../project/projects.ts',
    '../workflow/workflow-tree-store.ts',
    './doc-read-store.ts',
    './doc-write-allowed.ts',
  ]),
]
