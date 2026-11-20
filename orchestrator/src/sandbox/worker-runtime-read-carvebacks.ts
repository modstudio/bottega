// concern: exact extracted runtime assets needed by sandboxed worker processes.

import type { DistributionManifest } from '../../../shared/distribution-manifest.ts'
import { embeddedDistributionManifest } from '../../../shared/embedded-assets.ts'
import { workerRuntimeAssetPaths } from '../../../shared/runtime-assets-in-sandbox.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'

/** Resolve worker runtime assets only when this launch has embedded distribution payloads. */
export function workerRuntimeReadCarvebacks(
  environment: StateEnvironment,
  manifest: DistributionManifest | null = embeddedDistributionManifest(),
): string[] {
  if (!manifest) return []
  return workerRuntimeAssetPaths(resolveStateRoot(environment), manifest.version)
}
