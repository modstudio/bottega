// concern: release check
/** Validates a release tag and its generated local release inputs without probing hosted rungs. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUN_VERSION_FILE, readDeclaredBunVersion } from '../../../shared/bun-version.ts'
import { resolveInstallRoot } from '../../../shared/install-root.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import {
  checkReleaseBinaryAutoload,
  RELEASE_REQUIRE_PINNED_BUN_ENV,
} from './release-binary-autoload-check.ts'
import {
  readReleaseClientContract,
  releaseClientContractContentsRefusal,
} from './release-client-contract.ts'
import {
  releaseRungsDriftDecision,
  releaseRuntimeConfigGuardDecision,
  releaseTagVersionDecision,
} from './release-decision.ts'
import { readTrackedReleaseRungs, registeredReleaseRungs } from './release-rungs.ts'

function releaseCheckoutRoot(
  fromDirectory?: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return fromDirectory
    ? resolveInstallRoot(fromDirectory, environment)
    : resolveInstallRoot(import.meta.dir, environment)
}

function validateReleaseTagVersion(
  tag: string,
  root: string,
): { tag: string; reportedVersion: string } {
  const file = join(root, 'package.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read the reported version from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const reportedVersion =
    value && typeof value === 'object' ? (value as Record<string, unknown>).version : null
  if (typeof reportedVersion !== 'string' || !reportedVersion.trim()) {
    throw new Error(`cannot read the reported version from ${file}: version is missing or empty`)
  }
  const decision = releaseTagVersionDecision(reportedVersion, tag)
  if (!decision.ok) throw new Error(decision.message)
  return { tag, reportedVersion }
}

export type ReleaseCheckResult = {
  tag: string
  reportedVersion: string
  runtimeConfigGuardSkip: string | null
  rungsComparison: string
}

export type ReleaseCheckOptions = {
  skipClientContractDrift?: boolean
}

/** Validate local tag inputs; the tag-only workflow separately probes every hosted rung. */
export async function checkRelease(
  tag: string,
  fromDirectory?: string,
  environment: Record<string, string | undefined> = process.env,
  options: ReleaseCheckOptions = {},
): Promise<ReleaseCheckResult> {
  const root = releaseCheckoutRoot(fromDirectory, environment)
  const checked = validateReleaseTagVersion(tag, root)
  const contract = readReleaseClientContract(root, checked.reportedVersion)
  const contractRefusal = releaseClientContractContentsRefusal(
    contract.version,
    contract.snapshot,
    contract.current,
    { checkDrift: !options.skipClientContractDrift },
  )
  if (contractRefusal) throw new Error(contractRefusal)
  const drift = releaseRungsDriftDecision(readTrackedReleaseRungs(root), registeredReleaseRungs())
  if (drift.status === 'different') throw new Error(drift.message)
  const bunVersionFile = join(root, BUN_VERSION_FILE)
  let pinnedBunVersion: string | undefined
  try {
    pinnedBunVersion = readDeclaredBunVersion(bunVersionFile)
  } catch (error) {
    throw new Error(
      renderRefusal(
        refusal(
          `cannot read the pinned Bun version from ${bunVersionFile}: ${error instanceof Error ? error.message : String(error)}`,
          {
            kind: 'edit',
            text: `restore ${BUN_VERSION_FILE} with one plain Bun version, then retry`,
          },
        ),
      ),
    )
  }
  if (!pinnedBunVersion) {
    throw new Error(
      renderRefusal(
        refusal(`${bunVersionFile} must contain one plain Bun version, for example 1.4.4`, {
          kind: 'edit',
          text: `restore ${BUN_VERSION_FILE} with one plain Bun version, then retry`,
        }),
      ),
    )
  }
  const guard = releaseRuntimeConfigGuardDecision(
    Bun.version,
    pinnedBunVersion,
    environment[RELEASE_REQUIRE_PINNED_BUN_ENV] === '1',
  )
  if (guard.action === 'fail') throw new Error(guard.message)
  if (guard.action === 'run') await checkReleaseBinaryAutoload(root, tag, environment)
  return {
    ...checked,
    runtimeConfigGuardSkip: guard.action === 'skip' ? guard.message : null,
    rungsComparison: drift.message,
  }
}
