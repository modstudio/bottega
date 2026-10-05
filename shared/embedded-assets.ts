import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, relative } from 'node:path'

import type { DistributionManifest } from './install-root.ts'

export type EmbeddedRuntimeFile = {
  destination: string
  mode: number
  bytes: Buffer
  digest: string
}

type VerificationFailure = { path: string; check: string }

let quarantineSequence = 0

export function embeddedRuntimeDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function failure(path: string, check: string): VerificationFailure {
  return { path, check }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function verifyDirectory(path: string, uid: number): VerificationFailure | undefined {
  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch {
    return failure(path, 'directory is missing')
  }
  if (stat.isSymbolicLink()) return failure(path, 'directory is a symbolic link')
  if (!stat.isDirectory()) return failure(path, 'expected a directory')
  if (stat.uid !== uid)
    return failure(path, `owner uid ${stat.uid} does not match current uid ${uid}`)
  if ((stat.mode & 0o022) !== 0) return failure(path, 'directory is group- or world-writable')
  return undefined
}

function findSymlink(path: string): string | undefined {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const stat = lstatSync(child)
    if (stat.isSymbolicLink()) return child
    if (stat.isDirectory()) {
      const nested = findSymlink(child)
      if (nested) return nested
    }
  }
  return undefined
}

function payloadDirectories(root: string, path: string): string[] {
  const directories: string[] = []
  for (let current = dirname(path); current !== root; current = dirname(current)) {
    directories.push(current)
  }
  return directories.reverse()
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}

function verifyPayload(
  root: string,
  version: string,
  asset: EmbeddedRuntimeFile,
  uid: number,
): VerificationFailure | undefined {
  const path = join(root, asset.destination)
  for (const directory of payloadDirectories(root, path)) {
    const invalid = verifyDirectory(directory, uid)
    if (invalid) return invalid
  }

  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch {
    return failure(path, 'payload is missing')
  }
  if (stat.isSymbolicLink()) return failure(path, 'payload is a symbolic link')
  if (!stat.isFile()) return failure(path, 'payload is not a regular file')
  if (stat.uid !== uid) {
    return failure(path, `owner uid ${stat.uid} does not match current uid ${uid}`)
  }
  const mode = stat.mode & 0o777
  if (mode !== asset.mode) {
    return failure(path, `mode ${mode.toString(8)} does not match ${asset.mode.toString(8)}`)
  }
  const digest = embeddedRuntimeDigest(readFileSync(path))
  if (digest !== asset.digest) return failure(path, 'SHA-256 does not match embedded payload')
  if (!isWithin(realpathSync(version), realpathSync(path))) {
    return failure(path, 'payload real path escapes the runtime version directory')
  }
  return undefined
}

function verifyRuntime(
  root: string,
  expected: EmbeddedRuntimeFile[],
): VerificationFailure | undefined {
  const uid = userInfo().uid
  const version = dirname(root)
  for (const directory of [version, root]) {
    const invalid = verifyDirectory(directory, uid)
    if (invalid) return invalid
  }

  let symlink: string | undefined
  try {
    symlink = findSymlink(root)
  } catch {
    return failure(root, 'runtime tree could not be traversed')
  }
  if (symlink) return failure(symlink, 'runtime tree contains a symbolic link')

  for (const asset of expected) {
    const invalid = verifyPayload(root, version, asset, uid)
    if (invalid) return invalid
  }
  return undefined
}

function quarantine(path: string): void {
  if (!entryExists(path)) return
  const destination = `${path}.invalid-${Date.now()}-${process.pid}-${quarantineSequence++}`
  renameSync(path, destination)
}

function publishRuntime(root: string, expected: EmbeddedRuntimeFile[]): void {
  const parent = dirname(root)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temporary = mkdtempSync(join(parent, `.${root.split('/').at(-1)}-`))
  try {
    for (const asset of expected) {
      const destination = join(temporary, asset.destination)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      writeFileSync(destination, asset.bytes, { mode: asset.mode })
      chmodSync(destination, asset.mode)
    }
    try {
      renameSync(temporary, root)
    } catch (error) {
      if (!entryExists(root)) throw error
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Extract and verify one complete embedded runtime tree before every use. */
export function extractEmbeddedRuntime(
  root: string,
  expected: EmbeddedRuntimeFile[],
  label: string,
): string {
  const version = dirname(root)
  if (entryExists(version)) {
    const invalidVersion = verifyDirectory(version, userInfo().uid)
    if (invalidVersion) quarantine(version)
  }

  if (entryExists(root)) {
    const invalid = verifyRuntime(root, expected)
    if (!invalid) return root
    quarantine(root)
  }

  publishRuntime(root, expected)
  const invalid = verifyRuntime(root, expected)
  if (invalid) {
    quarantine(root)
    throw new Error(`${label} verification failed: ${invalid.check}: ${invalid.path}`)
  }
  return root
}

export type RefGuardRuntimeAsset = {
  packagePath: string
  destination: string
  mode: 0o755
}

/** The single definition of the shared ref guard shipped in a compiled binary. */
export const REF_GUARD_RUNTIME_ASSET: RefGuardRuntimeAsset = {
  packagePath: 'orchestrator/hooks/reference-transaction',
  destination: 'ref-guard/reference-transaction',
  mode: 0o755,
}

type EmbeddedAssetRegistry = Readonly<Record<string, string>>
type EmbeddedFileRegistry = Readonly<Record<string, string>>

export type EmbeddedAssets = Readonly<{
  assets: EmbeddedAssetRegistry
  files: EmbeddedFileRegistry
  manifest: DistributionManifest
}>

let embedded: EmbeddedAssets | null = null

/** Install the assets and identity compiled into the self-contained executable. */
export function registerEmbeddedAssets(value: EmbeddedAssets | null): void {
  embedded = value
}

/** Read an install-root asset from the binary, or from disk in a source/tarball run. */
export function readInstallAsset(relativePath: string, diskPath: string): string {
  if (embedded === null) return readFileSync(diskPath, 'utf8')
  const value = embedded.assets[relativePath]
  if (value === undefined) {
    throw new Error(`compiled ${relativePath} asset is missing`)
  }
  return value
}

/** Resolve a Bun.file-openable install asset without falling through to disk in a binary. */
export function resolveInstallFile(relativePath: string, diskPath: string): string | undefined {
  if (embedded === null) return diskPath
  return embedded.files[relativePath]
}

export function embeddedDistributionManifest(): DistributionManifest | null {
  return embedded?.manifest ?? null
}
