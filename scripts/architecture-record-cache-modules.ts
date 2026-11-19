// concern: architecture-manifest
/** Hosted/local record-cache module allowlists. */

import { dirname, normalize } from 'node:path'

const module = (file: string, allowed: string[]) => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordCacheModules = [
  module('orchestrator/src/record/record-api-client-counts.ts', [
    './record-api-client-paths.ts',
    './record-cache-counts-contract.ts',
  ]),
  module('orchestrator/src/record/record-cache-counts.ts', [
    '../../../shared/record/tenant.ts',
    '../doc/doc-write-allowed.ts',
    './record-api-doc-tenant.ts',
    './record-cache-counts-contract.ts',
    './record-pool.ts',
  ]),
  module('orchestrator/src/record/record-cache-parity.ts', [
    'bun:sqlite',
    '../../../shared/brand.ts',
    '../../../shared/record-remedies.ts',
    './record-api-client.ts',
    './record-api-client-response.ts',
    './record-auth.ts',
    './record-cache.ts',
    './record-cache-counts-contract.ts',
    './record-cache-ownership.ts',
  ]),
]
