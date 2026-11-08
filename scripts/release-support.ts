import { fileURLToPath } from 'node:url'
import { startBounded } from '../shared/bounded-process.ts'
import { PLATFORM_NAME } from '../shared/brand.ts'
import type { DistributionManifest } from '../shared/install-root.ts'
import { RELEASE_TAG_SHAPE, releaseTagVersion } from '../shared/release-tag.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export function releaseVersion(tag: string): string {
  const version = releaseTagVersion(tag)
  if (version === null) {
    throw new Error(`release tag must match ${RELEASE_TAG_SHAPE}: received ${JSON.stringify(tag)}`)
  }
  return version
}

export function distributionManifest(
  version: string,
  built: string,
  commit: string,
): DistributionManifest {
  return { name: PLATFORM_NAME, version, built, commit }
}

export async function run(argv: string[], cwd = repositoryRoot): Promise<string> {
  const child = await startBounded(argv, { budget: 'self-cli', cwd })
  if (child.exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${child.exitCode}`)
  return child.stdout.trim()
}
