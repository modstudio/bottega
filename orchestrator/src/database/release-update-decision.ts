// concern: release update decisions
/** Pure path, channel, compatibility, and refusal decisions for an installed update. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  artifactName,
  DOWNLOAD_BASE_URL_ENV,
  INSTALL_SCRIPT_URL,
  parseSha256Sums,
} from '../../../shared/release-artifacts.ts'
import type { MigrationJournalEntry } from './migration-compatibility.ts'
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
  | { action: 'current'; version: string; message: string }

export function resolveReleaseVersion(input: {
  sums: string
  target: string
  requestedVersion?: string
  currentVersion: string
  sumsUrl: string
}): ReleaseResolution {
  const entries = parseSha256Sums(input.sums)
  let version: string
  let asset: string
  if (input.requestedVersion) {
    version = normalizeReleaseVersion(input.requestedVersion)
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
    return {
      action: 'current',
      version,
      message: `already at ${version}; name a version to install another`,
    }
  }
  return { action: 'install', version, asset, digest: entries.get(asset)! }
}

export type AppliedMigration = { when: number; tag: string | null }

export type CandidateStoreDecision =
  | { state: 'ahead' }
  | { state: 'positioned'; position: number; drain: MigrationDrainDecision }

export function candidateStoreDecision(
  applied: readonly AppliedMigration[],
  journal: MigrationJournalEntry[],
): CandidateStoreDecision {
  if (applied.length > journal.length) return { state: 'ahead' }
  for (const [index, row] of applied.entries()) {
    const candidate = journal[index]
    if (
      !candidate ||
      candidate.when !== row.when ||
      (row.tag !== null && candidate.tag !== row.tag)
    ) {
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

export function predatesUpdateRefusal(version: string): string {
  return (
    `release ${version} predates in-place update; install it with the installer: ` +
    `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- ${version}`
  )
}

export function storeAheadRefusal(currentVersion: string): string {
  return (
    `the store is ahead of release ${currentVersion}; ` +
    `update to ${currentVersion} or newer before retrying`
  )
}

export function digestMismatchRefusal(asset: string, expected: string, received: string): string {
  return (
    `digest mismatch for ${asset}: expected ${expected}, received ${received}; ` +
    `retry, or check ${DOWNLOAD_BASE_URL_ENV}`
  )
}

export function unsupportedDownloadSchemeRefusal(scheme: string): string {
  return (
    `unsupported download URL scheme ${scheme}; ` +
    `set ${DOWNLOAD_BASE_URL_ENV} to an http:, https:, or file: URL`
  )
}
