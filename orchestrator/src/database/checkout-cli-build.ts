// concern: atomically compiled checkout CLI used by confined worker processes.

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitAt } from '../../../shared/git.ts'
import { INSTALL_HOME_ENV, installationIdentity } from '../../../shared/install-root.ts'
import {
  WORKER_RUNTIME_ASSETS,
  workerRuntimeAssetPaths,
} from '../../../shared/runtime-assets-in-sandbox.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'

export type CheckoutCliBuildResult = {
  binary: string
  stamp: string
  head: string
  lockHash: string
  binaryHash: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function checkoutHead(checkoutRoot: string): string {
  const result = gitAt(checkoutRoot, ['rev-parse', 'HEAD'])
  if (result.code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed with exit ${result.code}: ${result.stderr.trim()}; rerun ${PLATFORM_SLUG} machine update`,
    )
  }
  return result.stdout.trim()
}

/** Compile and atomically publish the checkout CLI, with its proof stamp written last. */
export function buildCheckoutCli(
  checkoutRoot: string,
  environment: StateEnvironment = process.env,
): CheckoutCliBuildResult {
  const identity = installationIdentity(checkoutRoot, {
    ...environment,
    [INSTALL_HOME_ENV]: checkoutRoot,
  })
  if (identity.kind !== 'checkout') throw new Error('checkout CLI build requires a checkout')
  const [binary, stamp] = workerRuntimeAssetPaths(resolveStateRoot(environment), identity.version, {
    checkoutCli: WORKER_RUNTIME_ASSETS.checkoutCli,
    checkoutCliStamp: WORKER_RUNTIME_ASSETS.checkoutCliStamp,
  })
  if (!binary || !stamp) throw new Error('checkout CLI runtime assets are not declared')
  const destination = dirname(binary)
  mkdirSync(destination, { recursive: true })
  const suffix = `${process.pid}-${Bun.randomUUIDv7()}`
  const temporaryBinary = join(destination, `.checkout-cli-${suffix}`)
  const temporaryStamp = join(destination, `.checkout-cli-stamp-${suffix}`)
  try {
    const result = startBoundedSync(
      ['bun', 'build', '--compile', `cli/${PLATFORM_SLUG}.ts`, '--outfile', temporaryBinary],
      {
        budget: 'machine-update',
        cwd: checkoutRoot,
        env: { ...environment, [INSTALL_HOME_ENV]: checkoutRoot },
      },
    )
    if (result.exitCode !== 0) {
      throw new Error(
        `bun build --compile failed with exit ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}; rerun ${PLATFORM_SLUG} machine update`,
      )
    }
    chmodSync(temporaryBinary, 0o755)
    const head = checkoutHead(checkoutRoot)
    const lockHash = sha256(join(checkoutRoot, 'bun.lock'))
    const binaryHash = sha256(temporaryBinary)
    const contents = `head=${head}\nlock=${lockHash}\nbinary=${binaryHash}\n`
    writeFileSync(temporaryStamp, contents, { mode: 0o600 })
    renameSync(temporaryBinary, binary)
    renameSync(temporaryStamp, stamp)
    return { binary, stamp, head, lockHash, binaryHash }
  } finally {
    rmSync(temporaryBinary, { force: true })
    rmSync(temporaryStamp, { force: true })
  }
}
