// concern: sandbox-runtime availability and extracted payload adapter; must not know sandbox policy.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type SandboxRuntimeConfig as LibrarySandboxRuntimeConfig,
  SandboxManager,
} from '@anthropic-ai/sandbox-runtime'
import {
  embeddedDistributionManifest,
  resolveInstallFile,
} from '../../../shared/embedded-assets.ts'
import {
  type SandboxRuntimeAssets,
  type SandboxRuntimePayload,
  sandboxRuntimeAssets,
} from '../../../shared/sandbox-runtime-assets.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'
import { ROOT } from '../database/db.ts'

export const SRT_LIBRARY = join(
  ROOT,
  'node_modules',
  '@anthropic-ai',
  'sandbox-runtime',
  'dist',
  'index.js',
)

let sandboxInitialized = false
let quarantineSequence = 0

type RuntimeAvailability = { available: boolean; location: string }
type ExtractedRuntime = {
  root: string
  javaAgentJarPath: string
  seccompApplyPath?: string
  srtWinPath?: string
}

type ExtractionPorts = {
  environment?: StateEnvironment
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  resolveFile?: (relativePath: string, diskPath: string) => string | undefined
  readFile?: (path: string) => Promise<ArrayBuffer>
}

type ExpectedPayload = SandboxRuntimePayload & { bytes: Buffer; digest: string }
type VerificationFailure = { path: string; check: string }

function extractedRoot(environment: StateEnvironment, version: string): string {
  return join(resolveStateRoot(environment), 'runtime', version, 'sandbox-runtime')
}

function diskPayloadPath(relativePath: string): string {
  return join(ROOT, relativePath)
}

function payloads(assets: SandboxRuntimeAssets): SandboxRuntimePayload[] {
  return Object.values(assets)
}

/** One availability ruling used by every caller and by doctor presentation. */
export function sandboxRuntimeAvailability(
  environment: StateEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): RuntimeAvailability {
  const manifest = embeddedDistributionManifest()
  if (!manifest) return { available: existsSync(SRT_LIBRARY), location: SRT_LIBRARY }
  const assets = sandboxRuntimeAssets(platform, arch)
  const required = payloads(assets)
  return {
    available:
      (required.length > 1 || platform === 'darwin') &&
      required.every(
        ({ packagePath }) =>
          resolveInstallFile(packagePath, diskPayloadPath(packagePath)) !== undefined,
      ),
    location: extractedRoot(environment, manifest.version),
  }
}

export function srtInstalled(): boolean {
  return sandboxRuntimeAvailability().available
}

async function expectedPayloads(
  assets: SandboxRuntimeAssets,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  resolveFile: NonNullable<ExtractionPorts['resolveFile']>,
  readFile: NonNullable<ExtractionPorts['readFile']>,
): Promise<ExpectedPayload[]> {
  const required = payloads(assets)
  if (required.length === 1 && platform !== 'darwin') {
    throw new Error(`compiled sandbox runtime has no payloads for ${platform}-${arch}`)
  }
  return Promise.all(
    required.map(async (asset) => {
      const source = resolveFile(asset.packagePath, diskPayloadPath(asset.packagePath))
      if (!source) {
        throw new Error(`compiled sandbox runtime payload is missing: ${asset.packagePath}`)
      }
      const bytes = Buffer.from(await readFile(source))
      return {
        ...asset,
        bytes,
        digest: createHash('sha256').update(bytes).digest('hex'),
      }
    }),
  )
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

function verifyPayload(
  root: string,
  asset: ExpectedPayload,
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
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (digest !== asset.digest) return failure(path, 'SHA-256 does not match embedded payload')
  return undefined
}

function verifyRuntime(root: string, expected: ExpectedPayload[]): VerificationFailure | undefined {
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
    const invalid = verifyPayload(root, asset, uid)
    if (invalid) return invalid
  }
  return undefined
}

function quarantine(path: string): void {
  if (!entryExists(path)) return
  const destination = `${path}.invalid-${Date.now()}-${process.pid}-${quarantineSequence++}`
  renameSync(path, destination)
}

async function publishRuntime(root: string, expected: ExpectedPayload[]): Promise<void> {
  const parent = dirname(root)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temporary = mkdtempSync(join(parent, '.sandbox-runtime-'))
  try {
    for (const asset of expected) {
      const destination = join(temporary, asset.destination)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      writeFileSync(destination, asset.bytes, { mode: asset.mode })
      chmodSync(destination, asset.mode)
    }
    // Let concurrent extractors finish their temporary trees before publication.
    await Promise.resolve()
    try {
      renameSync(temporary, root)
    } catch (error) {
      if (!entryExists(root)) throw error
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/**
 * Extract complete embedded runtime payloads and verify them before every use.
 * A residual race remains between verification and the runtime executing a helper;
 * eliminating it would require descriptor passing that the runtime does not support.
 */
export async function extractSandboxRuntime(
  ports: ExtractionPorts = {},
): Promise<ExtractedRuntime> {
  const manifest = embeddedDistributionManifest()
  if (!manifest) {
    return { root: join(SRT_LIBRARY, '..', '..'), javaAgentJarPath: '' }
  }
  const environment = ports.environment ?? process.env
  const platform = ports.platform ?? process.platform
  const arch = ports.arch ?? process.arch
  const assets = sandboxRuntimeAssets(platform, arch)
  const expected = await expectedPayloads(
    assets,
    platform,
    arch,
    ports.resolveFile ?? resolveInstallFile,
    ports.readFile ?? ((path) => Bun.file(path).arrayBuffer()),
  )
  const root = extractedRoot(environment, manifest.version)
  const version = dirname(root)

  if (entryExists(version)) {
    const invalidVersion = verifyDirectory(version, userInfo().uid)
    if (invalidVersion) quarantine(version)
  }

  if (entryExists(root)) {
    const invalid = verifyRuntime(root, expected)
    if (!invalid) return runtimePaths(root, assets)
    quarantine(root)
  }

  await publishRuntime(root, expected)
  const invalid = verifyRuntime(root, expected)
  if (invalid) {
    quarantine(root)
    throw new Error(`sandbox runtime verification failed: ${invalid.check}: ${invalid.path}`)
  }
  return runtimePaths(root, assets)
}

function runtimePaths(root: string, assets: SandboxRuntimeAssets): ExtractedRuntime {
  return {
    root,
    javaAgentJarPath: join(root, assets.javaAgent.destination),
    ...(assets.seccompApply
      ? { seccompApplyPath: join(root, assets.seccompApply.destination) }
      : {}),
    ...(assets.srtWin ? { srtWinPath: join(root, assets.srtWin.destination) } : {}),
  }
}

async function prepareSandboxRuntimeConfig(): Promise<Partial<LibrarySandboxRuntimeConfig>> {
  if (!embeddedDistributionManifest()) return {}
  const runtime = await extractSandboxRuntime()
  return {
    javaAgentJarPath: runtime.javaAgentJarPath,
    ...(runtime.seccompApplyPath ? { seccomp: { applyPath: runtime.seccompApplyPath } } : {}),
    ...(runtime.srtWinPath ? { windows: { srtWin: { path: runtime.srtWinPath } } } : {}),
  }
}

export async function launchWithSandboxRuntime(
  config: LibrarySandboxRuntimeConfig,
  command: string,
): Promise<string[]> {
  const payload = await prepareSandboxRuntimeConfig()
  const configured = { ...config, ...payload }
  if (sandboxInitialized) SandboxManager.updateConfig(configured)
  else {
    await SandboxManager.initialize(configured)
    sandboxInitialized = true
  }
  return (await SandboxManager.wrapWithSandboxArgv(command)).argv
}

export async function resetSandboxRuntime(): Promise<void> {
  if (!sandboxInitialized) return
  await SandboxManager.reset()
  sandboxInitialized = false
}
