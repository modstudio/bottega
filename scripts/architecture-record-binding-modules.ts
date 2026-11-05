// concern: architecture-manifest
/** Install-binding and record write-authority module allowlists, split out to keep the record manifest within its file ceiling. */
import { dirname, normalize } from 'node:path'

type RecordModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): RecordModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordBindingModules: RecordModule[] = [
  module('orchestrator/src/record/install-binding.ts', ['bun:sqlite']),
  module('orchestrator/src/record/install-binding-write.ts', [
    'bun:sqlite',
    '../../../shared/record-api-url.ts',
    '../database/db.ts',
    './install-binding.ts',
  ]),
  module('orchestrator/src/record/record-write-decision.ts', ['../../../shared/brand.ts']),
  module('orchestrator/src/record/record-write-authority.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-api-url.ts',
    '../database/db.ts',
    './install-binding.ts',
    './install-binding-write.ts',
    './record-write-decision.ts',
  ]),
]
