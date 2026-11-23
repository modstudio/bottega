// concern: host-side freshness decision for the checkout CLI used by confined runs.

import { readFileSync, statSync } from 'node:fs'
import {
  CHECKOUT_CLI_BINARY_ENV,
  checkoutHeadCommit,
  INSTALL_HOME_ENV,
  installationIdentity,
  runningInstallationKind,
  runningInstallRoot,
} from '../../../shared/install-root.ts'
import {
  CHECKOUT_CLI_RUNTIME_ASSETS,
  stampValues,
  workerRuntimeAssetPaths,
} from '../../../shared/runtime-assets-in-sandbox.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'

export { CHECKOUT_CLI_BINARY_ENV } from '../../../shared/install-root.ts'

type CheckoutCliBinaryStat = {
  size: number
  mtime: number
  inode: number
}

export type CheckoutCliFreshnessFacts = {
  /** The checkout commit resolved from detached HEAD, a loose ref, or packed-refs. */
  headSha: string | null
  stampContents: string | null
  binaryStat: CheckoutCliBinaryStat | null
  readError: boolean
}

export type CheckoutCliFreshnessDecision = (facts: CheckoutCliFreshnessFacts) => boolean

/** Decide checkout CLI freshness using only facts already gathered by the host. */
export function decideCliBinaryFreshness(facts: CheckoutCliFreshnessFacts): boolean {
  if (facts.readError || !facts.stampContents || !facts.binaryStat) return false
  if (!facts.headSha || !/^[0-9a-f]{40,64}$/i.test(facts.headSha)) return false
  const stamp = stampValues(facts.stampContents)
  return (
    stamp.head === facts.headSha &&
    stamp.size === String(facts.binaryStat.size) &&
    stamp.mtime === String(facts.binaryStat.mtime) &&
    stamp.inode === String(facts.binaryStat.inode)
  )
}

function checkoutCliFreshnessFacts(
  checkoutRoot: string,
  binary: string,
  stamp: string,
): CheckoutCliFreshnessFacts {
  const headSha = checkoutHeadCommit(checkoutRoot) ?? null
  let stampContents: string | null = null
  let binaryStat: CheckoutCliBinaryStat | null = null
  let readError = false
  try {
    stampContents = readFileSync(stamp, 'utf8')
    const metadata = statSync(binary)
    binaryStat = {
      size: metadata.size,
      mtime: Math.trunc(metadata.mtimeMs / 1_000),
      inode: metadata.ino,
    }
  } catch {
    readError = true
  }
  return {
    headSha,
    stampContents,
    binaryStat,
    readError,
  }
}

/** Select the current checkout CLI on the host before constructing a confined run environment. */
export function checkoutCliBinaryEnvironment(
  environment: StateEnvironment = process.env,
  decide: CheckoutCliFreshnessDecision = decideCliBinaryFreshness,
): Record<string, string> {
  const checkoutRoot = runningInstallRoot(import.meta.dir, environment)
  if (runningInstallationKind(import.meta.dir, environment) !== 'checkout') return {}
  const identity = installationIdentity(checkoutRoot, {
    ...environment,
    [INSTALL_HOME_ENV]: checkoutRoot,
  })
  if (identity.kind !== 'checkout') return {}
  const [binary, stamp] = workerRuntimeAssetPaths(
    resolveStateRoot(environment),
    identity.version,
    CHECKOUT_CLI_RUNTIME_ASSETS,
  )
  if (!binary || !stamp) return {}
  return decide(checkoutCliFreshnessFacts(checkoutRoot, binary, stamp))
    ? { [CHECKOUT_CLI_BINARY_ENV]: binary }
    : {}
}
