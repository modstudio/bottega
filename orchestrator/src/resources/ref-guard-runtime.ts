// concern: ref-guard runtime asset
/** Extracts and verifies the shared ref guard shipped inside the compiled binary. */
import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  embeddedDistributionManifest,
  REF_GUARD_RUNTIME_ASSET,
} from '../../../shared/embedded-assets.ts'
import { runtimeAssetPath } from '../../../shared/runtime-assets.ts'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import { ROOT } from '../database/db.ts'

/** Select the tracked checkout hook or the installed binary's extracted hook. */
export function refGuardRuntimePath(input: {
  embeddedVersion: string | null
  sourceRoot: string
  stateRoot: string
}): string {
  return input.embeddedVersion
    ? join(
        input.stateRoot,
        'runtime',
        input.embeddedVersion,
        'assets',
        REF_GUARD_RUNTIME_ASSET.destination,
      )
    : join(input.sourceRoot, relative('orchestrator', REF_GUARD_RUNTIME_ASSET.packagePath))
}

/** Resolve the checkout hook or extract and SHA-256 verify the binary's embedded hook. */
export function resolveRefGuardHook(
  environment: StateEnvironment = process.env,
  sourceRoot = ROOT,
): string {
  const manifest = embeddedDistributionManifest()
  if (!manifest)
    return realpathSync(refGuardRuntimePath({ embeddedVersion: null, sourceRoot, stateRoot: '' }))
  return runtimeAssetPath(REF_GUARD_RUNTIME_ASSET.packagePath, environment)
}
