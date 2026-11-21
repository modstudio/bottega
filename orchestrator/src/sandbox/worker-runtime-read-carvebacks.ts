// concern: exact extracted runtime assets needed by sandboxed worker processes.

import type { DistributionManifest } from '../../../shared/distribution-manifest.ts'
import { embeddedDistributionManifest } from '../../../shared/embedded-assets.ts'
import { runningInstallationIdentity } from '../../../shared/install-root.ts'
import {
  CHECKOUT_CLI_RUNTIME_ASSETS,
  workerRuntimeAssetPaths,
} from '../../../shared/runtime-assets-in-sandbox.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'

/** Resolve only the runtime assets required by this installation kind. */
export function workerRuntimeReadCarvebacks(
  environment: StateEnvironment,
  manifest: DistributionManifest | null = embeddedDistributionManifest(),
): string[] {
  const stateRoot = resolveStateRoot(environment)
  if (manifest) return workerRuntimeAssetPaths(stateRoot, manifest.version)
  const identity = runningInstallationIdentity(import.meta.dir, environment)
  if (identity.kind !== 'checkout') return []
  return workerRuntimeAssetPaths(stateRoot, identity.version, CHECKOUT_CLI_RUNTIME_ASSETS)
}
