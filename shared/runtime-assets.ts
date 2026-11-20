// concern: installed runtime assets
/** Resolves real files used by outside processes in checkouts and compiled distributions. */

import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  embeddedDistributionManifest,
  embeddedRuntimeDigest,
  extractEmbeddedRuntime,
  RUNTIME_ASSETS,
  readInstallAsset,
  type RuntimeAsset,
} from './embedded-assets.ts'
import { assetPath } from './install-root.ts'
import { resolveStateRoot, type StateEnvironment } from './state-directory.ts'

const RUNTIME_DIRECTORY = 'assets'

/** Compose a runtime asset's path relative to its version-scoped directory. */
export function extractedRuntimeAssetRelativePath(asset: Pick<RuntimeAsset, 'destination'>): string {
  return join(RUNTIME_DIRECTORY, asset.destination)
}

/** Whether runtime assets come from the compiled binary rather than a checkout. */
function runtimeAssetsAreEmbedded(): boolean {
  return embeddedDistributionManifest() !== null
}

/** The version-scoped root containing extracted runtime assets. */
export function extractedRuntimeRootPath(stateRoot: string, version: string): string {
  return join(stateRoot, 'runtime', version, RUNTIME_DIRECTORY)
}

/** Resolve one runtime asset under the version-scoped extracted layout. */
export function extractedRuntimeAssetPath(
  stateRoot: string,
  version: string,
  asset: Pick<RuntimeAsset, 'destination'>,
): string {
  return join(stateRoot, 'runtime', version, extractedRuntimeAssetRelativePath(asset))
}

function extractedRuntimeRoot(environment: StateEnvironment): string {
  const manifest = embeddedDistributionManifest()
  if (!manifest) throw new Error('an extracted runtime exists only in a compiled distribution')
  const expected = RUNTIME_ASSETS.map((asset) => {
    const bytes = Buffer.from(readInstallAsset(asset.packagePath, ''))
    return { ...asset, bytes, digest: embeddedRuntimeDigest(bytes) }
  })
  return extractEmbeddedRuntime(
    extractedRuntimeRootPath(resolveStateRoot(environment), manifest.version),
    expected,
    'compiled runtime assets',
  )
}

/** Resolve the root shared by every declared runtime asset. */
export function runtimeAssetRoot(environment: StateEnvironment = process.env): string {
  if (!runtimeAssetsAreEmbedded()) return realpathSync(assetPath())
  return realpathSync(extractedRuntimeRoot(environment))
}

/** Resolve a declared runtime asset to a verified, ordinary filesystem path. */
export function runtimeAssetPath(
  packagePath: string,
  environment: StateEnvironment = process.env,
): string {
  const asset = RUNTIME_ASSETS.find((entry) => entry.packagePath === packagePath)
  if (!asset) throw new Error(`runtime asset is not declared: ${packagePath}`)
  if (!runtimeAssetsAreEmbedded()) return realpathSync(assetPath(packagePath))
  return realpathSync(join(runtimeAssetRoot(environment), asset.destination))
}
