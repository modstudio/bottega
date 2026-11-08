// concern: architecture-manifest
/** Import allowlists for hosted active-space identity and verification. */
import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const recordInvariantModules = [
  module('orchestrator/src/record/active-space-invariant.ts', [
    '../../../shared/record-remedies.ts',
  ]),
  module('orchestrator/src/record/record-space.ts', [
    '../../../shared/brand.ts',
    '../../../shared/moderation-hide-reason.ts',
    '../../../shared/record-id.ts',
    '../../../shared/record/schema.ts',
    '../../../shared/record-space-membership.ts',
    './machine-name-command.ts',
    './machine-name.ts',
    './record-api-client.ts',
    './record-auth.ts',
    './record-cache-projects.ts',
    './record-moderation-hide.ts',
    './record-session.ts',
    './active-space-invariant.ts',
  ]),
]
