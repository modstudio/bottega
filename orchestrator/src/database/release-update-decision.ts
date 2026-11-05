// concern: release update decisions
/** Pure path, channel, compatibility, and refusal decisions for an installed update. */

import { createHash } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  artifactName,
  DOWNLOAD_BASE_URL_ENV,
  INSTALL_SCRIPT_URL,
  parseSha256Sums,
} from '../../../shared/release-artifacts.ts'
import type { MigrationJournalEntryWithHash } from './migration-compatibility.ts'
import { decideMigrationDrain, type MigrationDrainDecision } from './migration-drain-decision.ts'

export type UpdatePathDecision =
  | { action: 'checkout' }
  | { action: 'distribution' }
  | { action: 'refuse'; reason: string }

export function decideUpdatePath(
  kind: 'checkout' | 'distribution',
  version?: string,
): UpdatePathDecision {
  if (kind === 'checkout' && version) {
    return {
      action: 'refuse',
      reason:
        `refusing ${PLATFORM_SLUG} machine update ${version}: a checkout updates to its registered landing branch; ` +
        `run ${PLATFORM_SLUG} machine update`,
    }
  }
  return { action: kind }
}

export function normalizeReleaseVersion(value: string): string {
  const version = value.startsWith('v') ? value.slice(1) : value
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `invalid release version ${JSON.stringify(value)}; name a version as X.Y.Z or vX.Y.Z`,
    )
  }
  return version
}

export type ReleaseResolution =
  | { action: 'install'; version: string; asset: string; digest: string }
  | { action: 'current'; version: string }

export function resolveReleaseVersion(input: {
  sums: string
  target: string
  requestedVersion?: string
  currentVersion: string
  sumsUrl: string
}): ReleaseResolution {
  let entries: Map<string, string>
  try {
    entries = parseSha256Sums(input.sums)
  } catch (error) {
    throw new Error(
      `could not parse SHA256SUMS from ${input.sumsUrl}: ${error instanceof Error ? error.message : String(error)}; ` +
        `retry, or check ${DOWNLOAD_BASE_URL_ENV}`,
    )
  }
  let version: string
  let asset: string
  if (input.requestedVersion) {
    version = input.requestedVersion
    asset = artifactName(version, input.target)
    if (!entries.has(asset)) {
      throw new Error(
        `release ${version} is not available for ${input.target} at ${input.sumsUrl}; ` +
          `name an available version or check ${DOWNLOAD_BASE_URL_ENV}`,
      )
    }
  } else {
    const prefix = `${PLATFORM_SLUG}-`
    const suffix = `-${input.target}.tar.gz`
    const matches = [...entries.keys()].filter(
      (name) => name.startsWith(prefix) && name.endsWith(suffix),
    )
    if (matches.length !== 1) {
      throw new Error(
        `SHA256SUMS does not name exactly one latest artifact for ${input.target}; ` +
          `retry, or check ${DOWNLOAD_BASE_URL_ENV}`,
      )
    }
    asset = matches[0]!
    version = normalizeReleaseVersion(asset.slice(prefix.length, -suffix.length))
    if (asset !== artifactName(version, input.target)) {
      throw new Error(
        `invalid latest artifact name ${asset}; retry, or check ${DOWNLOAD_BASE_URL_ENV}`,
      )
    }
  }
  if (version === input.currentVersion) {
    return { action: 'current', version }
  }
  return { action: 'install', version, asset, digest: entries.get(asset)! }
}

export type AppliedMigration = { when: number; hash: string }

export type CandidateStoreDecision =
  | { state: 'ahead' }
  | { state: 'positioned'; position: number; drain: MigrationDrainDecision }

export function candidateStoreDecision(
  applied: readonly AppliedMigration[],
  journal: MigrationJournalEntryWithHash[],
): CandidateStoreDecision {
  if (applied.length > journal.length) return { state: 'ahead' }
  for (const [index, row] of applied.entries()) {
    const candidate = journal[index]
    if (!candidate || candidate.when !== row.when || candidate.hash !== row.hash) {
      return { state: 'ahead' }
    }
  }
  const position = applied.length
  return {
    state: 'positioned',
    position,
    drain: decideMigrationDrain({ journal, storeVersion: position }),
  }
}

function compareReleaseVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

export function releaseDowngradeRefusal(targetVersion: string, runningVersion: string): string | null {
  if (compareReleaseVersions(targetVersion, runningVersion) >= 0) return null
  return (
    `release ${targetVersion} is older than the running ${runningVersion}; ` +
    `install it with the installer: curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- ${targetVersion}`
  )
}

export function candidateIdentityRefusal(
  installation: { kind: 'distribution' | 'checkout'; version: string },
  expected: { version: string; asset: string; channelUrl: string },
): string | null {
  if (installation.kind === 'distribution' && installation.version === expected.version) return null
  return (
    `${expected.asset} from ${expected.channelUrl} identified itself as ` +
    `${installation.kind} ${installation.version}, not release ${expected.version}; ` +
    `retry ${expected.asset} from ${expected.channelUrl}`
  )
}

function probeDetail(exitStatus: number, stderr: string): string {
  return `probe exit ${exitStatus}; stderr: ${stderr.split(/\r?\n/, 1)[0] || '<empty>'}`
}

export function predatesUpdateRefusal(version: string, exitStatus: number, stderr: string): string {
  return (
    `release ${version} predates in-place update (${probeDetail(exitStatus, stderr)}); ` +
    `install it with the installer: ` +
    `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- ${version}`
  )
}

export function unreadableJournalSchemaRefusal(
  version: string,
  exitStatus: number,
  stderr: string,
): string {
  return (
    `release ${version} has a machine journal format this binary cannot read ` +
    `(${probeDetail(exitStatus, stderr)}); install it with the installer: ` +
    `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- ${version}`
  )
}

export function storeAheadRefusal(targetVersion: string, runningVersion: string): string {
  return (
    `the store is ahead of release ${targetVersion}; ` +
    `install ${runningVersion} or newer before retrying`
  )
}

function digestMismatchRefusal(asset: string, expected: string, received: string): string {
  return (
    `digest mismatch for ${asset}: expected ${expected}, received ${received}; ` +
    `retry, or check ${DOWNLOAD_BASE_URL_ENV}`
  )
}

function unsupportedDownloadSchemeRefusal(scheme: string): string {
  return (
    `unsupported download URL scheme ${scheme}; ` +
    `set ${DOWNLOAD_BASE_URL_ENV} to an http:, https:, or file: URL`
  )
}

export function downloadBaseUrlRefusal(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return (
      `${DOWNLOAD_BASE_URL_ENV} must be an absolute download URL; ` +
      `set it to an http:, https:, or file: URL`
    )
  }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:'
    ? null
    : unsupportedDownloadSchemeRefusal(url.protocol)
}

export function unsupportedTargetRefusal(platform: string, arch: string): string {
  return `unsupported release target ${platform}-${arch}; install on a supported platform`
}

export function verifyArchiveDigest(
  bytes: Uint8Array,
  expected: { asset: string; digest: string },
): string | null {
  const received = createHash('sha256').update(bytes).digest('hex')
  return received === expected.digest
    ? null
    : digestMismatchRefusal(expected.asset, expected.digest, received)
}

export type CurrentReleaseDecision =
  | { action: 'no-op'; message: string }
  | { action: 'migrate'; message: string }

export function decideCurrentReleaseUpdate(
  version: string,
  hasPendingMigrations: boolean,
): CurrentReleaseDecision {
  return hasPendingMigrations
    ? { action: 'migrate', message: `migrated the store to ${version}` }
    : { action: 'no-op', message: `already at ${version}; name a version to install another` }
}
