// concern: released client contract
/** Reads and validates the local client contract snapshot shipped by a release tag. */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const CURRENT_CONTRACT_REPO_PATH = 'scripts/quality/record-client-contract.json'
export const RELEASED_CONTRACT_REPO_DIRECTORY = 'scripts/quality/record-client-contracts'

export function releaseClientContractContentsRefusal(
  version: string,
  snapshot: string | null,
  current: string,
): string | null {
  const remedy = 'bun scripts/record-client-contract.ts --snapshot'
  if (snapshot === null) return `released client contract ${version} is missing; run ${remedy}`
  if (snapshot !== current)
    return `released client contract ${version} differs from the current contract; run ${remedy}`
  return null
}

export function readReleaseClientContract(
  root: string,
  tag: string,
): { version: string; snapshot: string | null; current: string } {
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  const snapshotPath = resolve(root, RELEASED_CONTRACT_REPO_DIRECTORY, `${version}.json`)
  return {
    version,
    snapshot: existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : null,
    current: readFileSync(resolve(root, CURRENT_CONTRACT_REPO_PATH), 'utf8'),
  }
}
