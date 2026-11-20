// concern: host-side freshness decision for the checkout CLI used by confined runs.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  INSTALL_HOME_ENV,
  installationIdentity,
  runningInstallationKind,
  runningInstallRoot,
} from '../../../shared/install-root.ts'
import {
  WORKER_RUNTIME_ASSETS,
  workerRuntimeAssetPaths,
} from '../../../shared/runtime-assets-in-sandbox.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'

type CheckoutCliBinaryStat = {
  size: number
  mtime: number
  inode: number
}

export type CheckoutCliFreshnessFacts = {
  /** HEAD resolved without packed refs. Detached HEAD has a value while refSha stays null. */
  headSha: string | null
  /** The sha read from the loose ref named by HEAD. */
  refSha: string | null
  stampContents: string | null
  binaryStat: CheckoutCliBinaryStat | null
  readError: boolean
}

export type CheckoutCliFreshnessDecision = (facts: CheckoutCliFreshnessFacts) => boolean

function stampValues(contents: string): Record<string, string> {
  return Object.fromEntries(
    contents
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=')
        return separator < 1 ? ['', ''] : [line.slice(0, separator), line.slice(separator + 1)]
      })
      .filter(([key]) => key),
  )
}

/** Decide checkout CLI freshness using only facts already gathered by the host. */
export function decideCliBinaryFreshness(facts: CheckoutCliFreshnessFacts): boolean {
  if (
    facts.readError ||
    !facts.headSha ||
    !facts.refSha ||
    facts.headSha !== facts.refSha ||
    !facts.stampContents ||
    !facts.binaryStat
  )
    return false
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
  let headSha: string | null = null
  let refSha: string | null = null
  let stampContents: string | null = null
  let binaryStat: CheckoutCliBinaryStat | null = null
  let readError = false
  try {
    if (!statSync(join(checkoutRoot, '.git')).isDirectory())
      return { headSha, refSha, stampContents, binaryStat, readError: false }
    const head = readFileSync(join(checkoutRoot, '.git', 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40,64}$/i.test(head)) {
      headSha = head
    } else if (head.startsWith('ref: ')) {
      const ref = head.slice('ref: '.length)
      if (/^refs\/[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes('..') && !ref.includes('//')) {
        refSha = readFileSync(join(checkoutRoot, '.git', ref), 'utf8').trim()
        headSha = refSha
      }
    }
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
  return { headSha, refSha, stampContents, binaryStat, readError }
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
  const [binary, stamp] = workerRuntimeAssetPaths(resolveStateRoot(environment), identity.version, {
    checkoutCli: WORKER_RUNTIME_ASSETS.checkoutCli,
    checkoutCliStamp: WORKER_RUNTIME_ASSETS.checkoutCliStamp,
  })
  if (!binary || !stamp) return {}
  return decide(checkoutCliFreshnessFacts(checkoutRoot, binary, stamp))
    ? { BOTTEGA_CLI_BINARY: binary }
    : {}
}
