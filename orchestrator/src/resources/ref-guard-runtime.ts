// concern: ref-guard runtime asset
/** Extracts and verifies the shared ref guard shipped inside the compiled binary. */
import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  embeddedDistributionManifest,
  embeddedRuntimeDigest,
  extractEmbeddedRuntime,
  REF_GUARD_RUNTIME_ASSET,
  readInstallAsset,
} from '../../../shared/embedded-assets.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'
import { ROOT } from '../database/db.ts'

/** Select the tracked checkout hook or the installed binary's extracted hook. */
export function refGuardRuntimePath(input: {
  embeddedVersion: string | null
  sourceRoot: string
  stateRoot: string
}): string {
  return input.embeddedVersion
    ? join(input.stateRoot, 'runtime', input.embeddedVersion, REF_GUARD_RUNTIME_ASSET.destination)
    : join(input.sourceRoot, relative('orchestrator', REF_GUARD_RUNTIME_ASSET.packagePath))
}

/** Resolve the checkout hook or extract and SHA-256 verify the binary's embedded hook. */
export function resolveRefGuardHook(
  environment: StateEnvironment = process.env,
  sourceRoot = ROOT,
): string {
  const manifest = embeddedDistributionManifest()
  const path = refGuardRuntimePath({
    embeddedVersion: manifest?.version ?? null,
    sourceRoot,
    stateRoot: resolveStateRoot(environment),
  })
  if (!manifest) return realpathSync(path)

  const bytes = Buffer.from(readInstallAsset(REF_GUARD_RUNTIME_ASSET.packagePath, ''))
  const runtimeRoot = join(resolveStateRoot(environment), 'runtime', manifest.version)
  extractEmbeddedRuntime(
    join(runtimeRoot, REF_GUARD_RUNTIME_ASSET.destination.split('/')[0]!),
    [
      {
        ...REF_GUARD_RUNTIME_ASSET,
        destination: REF_GUARD_RUNTIME_ASSET.destination.split('/').slice(1).join('/'),
        bytes,
        digest: embeddedRuntimeDigest(bytes),
      },
    ],
    'compiled shared ref guard',
  )
  return realpathSync(path)
}
