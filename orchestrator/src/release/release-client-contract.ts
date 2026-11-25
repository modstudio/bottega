// concern: released client contract
/** Reads and validates the local client contract snapshot shipped by a release tag. */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

export const CURRENT_CONTRACT_REPO_PATH = 'scripts/quality/record-client-contract.json'
export const RELEASED_CONTRACT_REPO_DIRECTORY = 'scripts/quality/record-client-contracts'

export function releasedContractSnapshotPath(root: string, version: string): string {
  return resolve(root, RELEASED_CONTRACT_REPO_DIRECTORY, `${version}.json`)
}

export function releaseClientContractContentsRefusal(
  version: string,
  snapshot: string | null,
  current: string,
  options: { checkDrift: boolean } = { checkDrift: true },
): string | null {
  if (snapshot === null)
    return `released client contract ${version} is missing; run bun scripts/record-client-contract.ts --snapshot`
  if (options.checkDrift && snapshot !== current)
    return `released client contract ${version} differs from the current contract; bump package.json to a new version, then run bun scripts/record-client-contract.ts --snapshot`
  return null
}

export function readReleaseClientContract(
  root: string,
  version: string,
): { version: string; snapshot: string | null; current: string } {
  const snapshotPath = releasedContractSnapshotPath(root, version)
  const currentPath = resolve(root, CURRENT_CONTRACT_REPO_PATH)
  if (!existsSync(currentPath)) {
    throw new Error(
      renderRefusal(
        refusal(`current client contract ${CURRENT_CONTRACT_REPO_PATH} is missing`, {
          kind: 'command',
          argv: ['bun', 'scripts/record-client-contract.ts', '--update'],
        }),
      ),
    )
  }
  return {
    version,
    snapshot: existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : null,
    current: readFileSync(currentPath, 'utf8'),
  }
}
