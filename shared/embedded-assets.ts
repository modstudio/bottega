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

import type { DistributionManifest } from './distribution-manifest.ts'

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

export type RuntimeAsset = {
  packagePath: string
  destination: string
  mode: 0o644 | 0o755
}

const executableHooks = new Set([
  'block-agent.py',
  'board-head-guard.py',
  'git-guard.py',
  'heartbeat-guard.py',
  'heartbeat-remind.py',
  'no-attribution.py',
  'orch-heartbeat.sh',
  'protect-main-checkout.py',
  'reference-transaction',
  'session-brief.py',
  'workflow-cursor-reminder.py',
])

const runtimeHookFiles = [
  'block-agent.py',
  'board-head-guard.py',
  'board-ack-guard.py',
  'board-interrupt.py',
  'board_hook_common.py',
  'bun-cache-guard.py',
  'context-precompact.py',
  'context-review.py',
  'editor_tool_judge.py',
  'git-guard.py',
  'heartbeat-board-observation.py',
  'heartbeat-decision.py',
  'heartbeat-guard.py',
  'heartbeat-remind.py',
  'heartbeat-run-observation.py',
  'hook_emission.py',
  'hook_paths.py',
  'hub-import-guard.py',
  'inbox_question_decision.py',
  'no-attribution.py',
  'notice_transport.py',
  'orch-heartbeat.sh',
  'protect-main-checkout.py',
  'protect_main_checkout.py',
  'reference-transaction',
  'registered_scope.py',
  'registered_scope_decision.py',
  'secret_shaped.py',
  'session-brief.py',
  'session-start-context.json',
  'session-start.py',
  'stop-summary.py',
  'test-substance-guard.py',
  'workflow-cursor-reminder.py',
] as const

/** Directory prefixes whose contents the binary builder embeds wholesale. */
export const EMBEDDED_ASSET_PREFIXES = [
  'orchestrator/migrations',
  'hub/migrations',
  'hub/web/dist',
  'ops/launchd',
  'ops/systemd',
] as const

/** Every real file that an installed binary exposes to an outside process. */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  ...runtimeHookFiles.map((file) => ({
    packagePath: `orchestrator/hooks/${file}`,
    destination: `orchestrator/hooks/${file}`,
    mode: executableHooks.has(file) ? (0o755 as const) : (0o644 as const),
  })),
  {
    packagePath: 'shared/store-write-lock.c',
    destination: 'shared/store-write-lock.c',
    mode: 0o644,
  },
  {
    packagePath: 'shared/secret-shaped-rules.json',
    destination: 'shared/secret-shaped-rules.json',
    mode: 0o644,
  },
  {
    packagePath: 'shared/attribution-markers.json',
    destination: 'shared/attribution-markers.json',
    mode: 0o644,
  },
  {
    packagePath: 'hub/src/note-curator-reply.schema.json',
    destination: 'hub/src/note-curator-reply.schema.json',
    mode: 0o644,
  },
]

/** The ref guard entry retained as a named consumer-facing member of the runtime set. */
export const REF_GUARD_RUNTIME_ASSET = RUNTIME_ASSETS.find(
  (asset) => asset.packagePath === 'orchestrator/hooks/reference-transaction',
)!

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

/** Read an install-root asset from the binary, or from a checkout or on-disk distribution root. */
export function readInstallAsset(relativePath: string, diskPath: string): string {
  if (embedded === null) return readFileSync(diskPath, 'utf8')
  const value = embedded.assets[relativePath]
  if (value === undefined) {
    throw new Error(`compiled ${relativePath} asset is missing`)
  }
  return value
}

/** List registered install assets beneath a path, or report that disk enumeration is required. */
export function listInstallAssetPaths(prefix: string): string[] | null {
  if (embedded === null) return null
  const directory = prefix.endsWith('/') ? prefix : `${prefix}/`
  return Object.keys(embedded.assets)
    .filter((path) => path.startsWith(directory))
    .sort()
}

/** Resolve a Bun.file-openable install asset without falling through to disk in a binary. */
export function resolveInstallFile(relativePath: string, diskPath: string): string | undefined {
  if (embedded === null) return diskPath
  return embedded.files[relativePath]
}

export function embeddedDistributionManifest(): DistributionManifest | null {
  return embedded?.manifest ?? null
}
