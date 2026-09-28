import { readFileSync } from 'node:fs'

import type { DistributionManifest } from './install-root.ts'

type EmbeddedAssetRegistry = Readonly<Record<string, string>>

export type EmbeddedAssets = Readonly<{
  assets: EmbeddedAssetRegistry
  manifest: DistributionManifest
}>

let embedded: EmbeddedAssets | null = null

/** Install the assets and identity compiled into the self-contained executable. */
export function registerEmbeddedAssets(value: EmbeddedAssets | null): void {
  embedded = value
}

/** Read an install-root asset from the binary, or from disk in a source/tarball run. */
export function readInstallAsset(relativePath: string, diskPath: string): string {
  if (embedded === null) return readFileSync(diskPath, 'utf8')
  const value = embedded.assets[relativePath]
  if (value === undefined) {
    throw new Error(`compiled ${relativePath} asset is missing`)
  }
  return value
}

export function embeddedDistributionManifest(): DistributionManifest | null {
  return embedded?.manifest ?? null
}
