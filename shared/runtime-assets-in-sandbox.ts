// concern: extracted runtime assets that sandboxed workers read or execute.

import { isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { REF_GUARD_RUNTIME_ASSET } from './embedded-assets.ts'
import { extractedRuntimeAssetRelativePath } from './runtime-assets.ts'

/** The extraction directory owned by the sandbox-runtime payload adapter. */
const SANDBOX_RUNTIME_ASSET_DIRECTORY = 'sandbox-runtime'
const CHECKOUT_CLI_DIRECTORY = 'checkout-cli'

/** Paths relative to <state>/runtime/<version> required inside worker sandboxes. */
export const WORKER_RUNTIME_ASSETS = {
  sandboxRuntime: SANDBOX_RUNTIME_ASSET_DIRECTORY,
  refGuard: extractedRuntimeAssetRelativePath(REF_GUARD_RUNTIME_ASSET),
  checkoutCli: join(CHECKOUT_CLI_DIRECTORY, PLATFORM_SLUG),
  checkoutCliStamp: join(CHECKOUT_CLI_DIRECTORY, `${PLATFORM_SLUG}.stamp`),
} as const

/** The exact runtime asset subset published and read for a compiled checkout CLI. */
export const CHECKOUT_CLI_RUNTIME_ASSETS = {
  checkoutCli: WORKER_RUNTIME_ASSETS.checkoutCli,
  checkoutCliStamp: WORKER_RUNTIME_ASSETS.checkoutCliStamp,
} as const

const CHECKOUT_CLI_STAMP_KEYS = ['head', 'lock', 'binary', 'size', 'mtime', 'inode'] as const

export type CheckoutCliStampKey = (typeof CHECKOUT_CLI_STAMP_KEYS)[number]
export type CheckoutCliStamp = Record<CheckoutCliStampKey, string | number>

/**
 * Format the compiled checkout CLI stamp. `bin/bottega` is the intentional
 * second reader of the size, mtime and inode lines because POSIX sh cannot
 * import this TypeScript owner.
 */
export function formatCheckoutCliStamp(values: CheckoutCliStamp): string {
  return `${CHECKOUT_CLI_STAMP_KEYS.map((key) => `${key}=${values[key]}`).join('\n')}\n`
}

/** Parse the declared compiled checkout CLI stamp fields from text. */
export function stampValues(contents: string): Partial<Record<CheckoutCliStampKey, string>> {
  const knownKeys = new Set<string>(CHECKOUT_CLI_STAMP_KEYS)
  return Object.fromEntries(
    contents
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=')
        return separator < 1 ? ['', ''] : [line.slice(0, separator), line.slice(separator + 1)]
      })
      .filter(([key]) => knownKeys.has(key)),
  )
}

function safeRuntimeAsset(entry: string, versionRoot: string): string {
  if (
    entry.length === 0 ||
    isAbsolute(entry) ||
    win32.isAbsolute(entry) ||
    entry.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`invalid worker runtime asset path: ${entry || '(empty)'}`)
  }
  const destination = resolve(versionRoot, entry)
  const fromRoot = relative(versionRoot, destination)
  if (fromRoot.length === 0 || fromRoot.startsWith(`..${win32.sep}`) || fromRoot === '..') {
    throw new Error(`worker runtime asset must be below the version root: ${entry}`)
  }
  return destination
}

/** Resolve declared worker runtime assets without widening above their exact paths. */
export function workerRuntimeAssetPaths(
  stateRoot: string,
  version: string,
  assets: Readonly<Record<string, string>> = WORKER_RUNTIME_ASSETS,
): string[] {
  const versionRoot = join(stateRoot, 'runtime', version)
  return Object.values(assets).map((entry) => safeRuntimeAsset(entry, versionRoot))
}
