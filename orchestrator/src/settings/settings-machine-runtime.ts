// concern: settings machine runtime adapter
/** Resolves product hook files and the executable they invoke. */

import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { runtimeAssetPath } from '../../../shared/runtime-assets.ts'
import { installedBottegaExecutable } from '../../../shared/self-spawn.ts'
import type { MachineHookRuntime } from './settings-machine-hooks.ts'

/** Gather the real runtime paths rendered into machine-owned harness settings. */
export function resolveMachineHookRuntime(): MachineHookRuntime {
  return {
    executable: installedBottegaExecutable() ?? join(assetPath(), 'bin', PLATFORM_SLUG),
    scriptPath: (file) => runtimeAssetPath(`orchestrator/hooks/${file}`),
  }
}
