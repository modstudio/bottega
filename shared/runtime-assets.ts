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
} from './embedded-assets.ts'
import { assetPath } from './install-root.ts'
import { resolveStateRoot, type StateEnvironment } from './state-directory.ts'

const RUNTIME_DIRECTORY = 'assets'

/** Whether runtime assets come from the compiled binary rather than a checkout. */
export function runtimeAssetsAreEmbedded(): boolean {
  return embeddedDistributionManifest() !== null
}

function extractedRuntimeRoot(environment: StateEnvironment): string {
  const manifest = embeddedDistributionManifest()
  if (!manifest) throw new Error('an extracted runtime exists only in a compiled distribution')
  const expected = RUNTIME_ASSETS.map((asset) => {
    const bytes = Buffer.from(readInstallAsset(asset.packagePath, ''))
    return { ...asset, bytes, digest: embeddedRuntimeDigest(bytes) }
  })
  return extractEmbeddedRuntime(
    join(resolveStateRoot(environment), 'runtime', manifest.version, RUNTIME_DIRECTORY),
    expected,
    'compiled runtime assets',
  )
}

/** Resolve a declared runtime asset to a verified, ordinary filesystem path. */
export function runtimeAssetPath(
  packagePath: string,
  environment: StateEnvironment = process.env,
): string {
  const asset = RUNTIME_ASSETS.find((entry) => entry.packagePath === packagePath)
  if (!asset) throw new Error(`runtime asset is not declared: ${packagePath}`)
  if (!runtimeAssetsAreEmbedded()) return realpathSync(assetPath(packagePath))
  return realpathSync(join(extractedRuntimeRoot(environment), asset.destination))
}
