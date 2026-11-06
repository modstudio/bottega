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
  module('orchestrator/src/record/record-api-read-routes.ts', [
    './record-api-releases.ts',
    './record-api-subjects.ts',
  ]),
  module('orchestrator/src/record/record-api-member-permission-routes.ts', [
    'hono',
    'zod',
    './record-auth.ts',
    './record-member-permission.ts',
  ]),
  module('orchestrator/src/record/record-member-permission.ts', [
    'bun',
    '../../../shared/record/tenant.ts',
    './record-config.ts',
    './record-config-error.ts',
    './record-pool.ts',
  ]),
  module('orchestrator/src/record/record-api-write-routes.ts', [
    'hono',
    './record-api-board.ts',
    './record-api-config-access-routes.ts',
    './record-api-doc-order.ts',
    './record-api-doc-counts.ts',
    './record-api-doc-rename.ts',
    './record-api-machine-key-claim-routes.ts',
    './record-api-member-permission-routes.ts',
    './record-api-moderation-routes.ts',
    './record-api-outside-block-routes.ts',
    './record-api-outside-intake-routes.ts',
    './record-api-projects.ts',
    './record-api-settings.ts',
    './record-auth.ts',
  ]),
  module('orchestrator/src/record/record-api-doc-counts.ts', [
    'hono',
    './record-api-doc-tenant.ts',
    './record-auth.ts',
  ]),
  module('orchestrator/src/record/record-api-doc-tenant.ts', [
    '../../../shared/personal-item-space.ts',
    './record-auth.ts',
    './record-docs.ts',
    './record-settings.ts',
  ]),
  module('orchestrator/src/record/record-api-doc-rename.ts', [
    'hono',
    'zod',
    './record-api-doc-tenant.ts',
    './record-auth.ts',
  ]),
  module('orchestrator/src/record/record-api-tenant.ts', [
    './record-api-doc-tenant.ts',
    './record-auth.ts',
  ]),
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
