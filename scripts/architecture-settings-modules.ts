// concern: architecture-manifest
/** Settings and config module allowlists, kept outside the root manifest to preserve its ceiling. */
import { dirname, normalize } from 'node:path'

type SettingsModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): SettingsModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const settingsModules: SettingsModule[] = [
  module('orchestrator/src/config/config-service.ts', [
    'node:os',
    '../../../shared/config-directory.ts',
    '../../../shared/config-client.ts',
    '../../../shared/hosted-config-space.ts',
    '../../../shared/hosted-secret-opening.ts',
    '../../../shared/machine-key-id.ts',
    '../../../shared/record-remedies.ts',
    '../../../shared/secret-envelope.ts',
    '../../../shared/machine-key-store.ts',
    '../../../shared/machine-config.ts',
    '../../../shared/trust-list.ts',
  ]),
  module('orchestrator/src/commands/config.ts', [
    'node:readline/promises',
    'commander',
    '../../../shared/config-client.ts',
    '../../../shared/release-autonomy.ts',
    '../config/config-service.ts',
    '../run/run-process.ts',
    './support.ts',
  ]),
  module('orchestrator/src/commands/settings.ts', [
    'commander',
    '../settings/settings-apply-commands.ts',
    '../settings/settings-commands.ts',
    '../settings/settings-machine-apply.ts',
    '../settings/settings-machine-permissions.ts',
    './support.ts',
  ]),
  module('orchestrator/src/settings/settings-permission.ts', ['./settings.ts']),
  module('orchestrator/src/settings/settings-permission-overlay.ts', [
    '../../../shared/machine-config.ts',
    './settings.ts',
  ]),
  module('orchestrator/src/settings/settings-machine-permissions.ts', [
    '../../../shared/machine-config.ts',
    '../run/run-process.ts',
  ]),
  module('orchestrator/src/settings/settings-machine-apply.ts', [
    'bun:sqlite',
    'fs',
    'path',
    '../../../shared/state-directory.ts',
    '../../../shared/machine-config.ts',
    '../canon/user-canon-home-files.ts',
    '../database/db.ts',
    '../doc/docs.ts',
    '../project/project-lock.ts',
    '../record/record-cache.ts',
    '../run/run-process.ts',
    './settings.ts',
    './settings-env.ts',
    './settings-files.ts',
    './settings-render.ts',
    './settings-permission-overlay.ts',
    './settings-write.ts',
  ]),
]
