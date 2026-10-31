// concern: architecture-manifest
/** Project command module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type ProjectModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): ProjectModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const projectModules: ProjectModule[] = [
  module('orchestrator/src/project/project-worktree-resolution.ts', [
    'node:fs',
    'node:path',
    '../worktree/worktree-lifecycle.ts',
    './project-settings.ts',
  ]),
  module('orchestrator/src/project/project-settings-patch.ts', []),
  module('orchestrator/src/project/project-add-decision.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-project-contract.ts',
    '../../../shared/record-space-membership.ts',
    '../record/record-project-columns.ts',
    '../record/record-project-destination.ts',
    './project-settings.ts',
  ]),
  module('orchestrator/src/project/project-add-record.ts', [
    '../../../shared/record-space-membership.ts',
    '../record/record-api-client.ts',
    '../record/record-write-authority.ts',
    './project-add-decision.ts',
    './project-settings.ts',
  ]),
  module('orchestrator/src/project/project-lock.ts', [
    '../../../shared/brand.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    '../../../shared/process-identity.ts',
  ]),
  module('orchestrator/src/project/project-hosted-write.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../../../shared/record-space-membership.ts',
    '../record/record-api-client.ts',
    '../record/record-project-destination.ts',
    '../record/record-project-destination-client.ts',
    '../record/record-write-authority.ts',
    './project-settings.ts',
  ]),
  module('orchestrator/src/project/project-record-identity.ts', [
    '../../../shared/brand.ts',
    '../../../shared/record-id.ts',
    '../record/record-api-client.ts',
    '../record/record-project-destination-client.ts',
    '../record/record-session.ts',
    '../record/record-write-authority.ts',
    '../database/db.ts',
    './project-settings.ts',
    './projects.ts',
  ]),
  module('orchestrator/src/project/project-rename.ts', ['../database/db.ts', './projects.ts']),
]
