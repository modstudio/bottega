import { fileURLToPath } from 'node:url'
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
  const child = Bun.spawn(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${exitCode}`)
  return output.trim()
}
