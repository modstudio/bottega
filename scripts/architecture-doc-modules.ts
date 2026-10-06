// concern: architecture-manifest
/** Document module allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

type DocModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): DocModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const docModules: DocModule[] = [
  module('orchestrator/src/doc/doc-tree-rules.ts', ['../../../shared/docs.ts']),
  module('orchestrator/src/doc/doc-subjects.ts', [
    '../../../shared/docs.ts',
    '../agent/agent-registry.ts',
    '../database/db.ts',
    '../jobs/jobs.ts',
  ]),
  module('orchestrator/src/doc/local-doc-tree-service.ts', [
    '../../../shared/docs.ts',
    '../database/db.ts',
    './doc-read-store.ts',
    './doc-tree-rules.ts',
  ]),
]
