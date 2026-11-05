// concern: release artifact identity
/** Names the release channel and its artifacts for publishers and installed updaters. */

import { PLATFORM_SLUG } from './brand.ts'

export const BINARY_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const
export type BinaryTarget = (typeof BINARY_TARGETS)[number]

export const RELEASE_REPOSITORY = `modstudio/${PLATFORM_SLUG}`
export const DEFAULT_RELEASE_DOWNLOAD_ROOT = `https://github.com/${RELEASE_REPOSITORY}/releases`
export const DOWNLOAD_BASE_URL_ENV = `${PLATFORM_SLUG.toUpperCase()}_DOWNLOAD_BASE_URL`
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main/install.sh`

export function artifactName(version: string, target: string): string {
  return `${PLATFORM_SLUG}-${version}-${target}.tar.gz`
}

export function parseSha256Sums(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([0-9a-fA-F]{64}) {2}([^/]+)$/.exec(line)
    if (!match) throw new Error(`invalid SHA256SUMS line: ${JSON.stringify(line)}`)
    entries.set(match[2]!, match[1]!.toLowerCase())
  }
  return entries
}

export function releaseTarget(platform: NodeJS.Platform, arch: string): BinaryTarget | null {
  const normalizedPlatform = platform === 'darwin' || platform === 'linux' ? platform : null
  const normalizedArch =
    arch === 'arm64' || arch === 'aarch64'
      ? 'arm64'
      : arch === 'x64' || arch === 'x86_64' || arch === 'amd64'
        ? 'x64'
        : null
  if (!normalizedPlatform || !normalizedArch) return null
  const target = `${normalizedPlatform}-${normalizedArch}`
  return (BINARY_TARGETS as readonly string[]).includes(target) ? (target as BinaryTarget) : null
}
