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
  CHECKOUT_CLI_RUNTIME_ASSETS,
  stampValues,
  workerRuntimeAssetPaths,
} from '../../../shared/runtime-assets-in-sandbox.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'

type CheckoutCliBinaryStat = {
  size: number
  mtime: number
  inode: number
}

export type CheckoutCliFreshnessFacts = {
  /** The sha held directly by a detached HEAD; null for a symbolic HEAD. */
  headSha: string | null
  /** The sha read from a symbolic HEAD's loose ref; null for a detached HEAD. */
  refSha: string | null
  /** The ref name held by a symbolic HEAD; null for a detached HEAD. */
  headRef: string | null
  /** packed-refs text read when a symbolic HEAD has no loose ref. */
  packedRefsContents: string | null
  symbolicHead: boolean
  stampContents: string | null
  binaryStat: CheckoutCliBinaryStat | null
  readError: boolean
}

export type CheckoutCliFreshnessDecision = (facts: CheckoutCliFreshnessFacts) => boolean

type SymbolicRefFacts = Pick<CheckoutCliFreshnessFacts, 'refSha' | 'headRef' | 'packedRefsContents'>

function packedRefSha(contents: string | null, ref: string): string | null {
  if (contents === null) return null
  let match: string | null = null
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const fields = line.split(' ')
    if (fields.length !== 2 || !/^[0-9a-f]{40,64}$/i.test(fields[0]!)) return null
    if (fields[1] !== ref) continue
    if (match !== null) return null
    match = fields[0]!
  }
  return match
}

function symbolicRefFacts(checkoutRoot: string, ref: string): SymbolicRefFacts {
  const facts: SymbolicRefFacts = { refSha: null, headRef: null, packedRefsContents: null }
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..') || ref.includes('//'))
    return facts
  facts.headRef = ref
  try {
    facts.refSha = readFileSync(join(checkoutRoot, '.git', ref), 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      facts.packedRefsContents = readFileSync(join(checkoutRoot, '.git', 'packed-refs'), 'utf8')
    } catch (packedError) {
      if ((packedError as NodeJS.ErrnoException).code !== 'ENOENT') throw packedError
    }
  }
  return facts
}

/** Decide checkout CLI freshness using only facts already gathered by the host. */
export function decideCliBinaryFreshness(facts: CheckoutCliFreshnessFacts): boolean {
  if (facts.readError || !facts.stampContents || !facts.binaryStat) return false
  const headSha = facts.symbolicHead
    ? facts.headRef && (facts.refSha ?? packedRefSha(facts.packedRefsContents, facts.headRef))
    : facts.headSha
  if (!headSha || !/^[0-9a-f]{40,64}$/i.test(headSha)) return false
  const stamp = stampValues(facts.stampContents)
  return (
    stamp.head === headSha &&
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
  let headRef: string | null = null
  let packedRefsContents: string | null = null
  let symbolicHead = false
  let stampContents: string | null = null
  let binaryStat: CheckoutCliBinaryStat | null = null
  let readError = false
  try {
    if (!statSync(join(checkoutRoot, '.git')).isDirectory())
      return {
        headSha,
        refSha,
        headRef,
        packedRefsContents,
        symbolicHead,
        stampContents,
        binaryStat,
        readError: false,
      }
    const head = readFileSync(join(checkoutRoot, '.git', 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40,64}$/i.test(head)) {
      headSha = head
    } else if (head.startsWith('ref: ')) {
      symbolicHead = true
      const ref = head.slice('ref: '.length)
      const refFacts = symbolicRefFacts(checkoutRoot, ref)
      refSha = refFacts.refSha
      headRef = refFacts.headRef
      packedRefsContents = refFacts.packedRefsContents
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
  return {
    headSha,
    refSha,
    headRef,
    packedRefsContents,
    symbolicHead,
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
    ? { BOTTEGA_CLI_BINARY: binary }
    : {}
}
