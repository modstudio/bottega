// concern: sandbox-runtime availability and extracted payload adapter; must not know sandbox policy.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type SandboxRuntimeConfig as LibrarySandboxRuntimeConfig,
  SandboxManager,
} from '@anthropic-ai/sandbox-runtime'
import {
  type EmbeddedRuntimeFile,
  embeddedDistributionManifest,
  embeddedRuntimeDigest,
  extractEmbeddedRuntime,
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

type ExpectedPayload = SandboxRuntimePayload & EmbeddedRuntimeFile

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
        digest: embeddedRuntimeDigest(bytes),
      }
    }),
  )
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
  await extractEmbeddedRuntime(root, expected, 'sandbox runtime')
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
