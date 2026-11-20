// concern: sandbox-runtime availability and extracted payload adapter; must not know sandbox policy.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type SandboxRuntimeConfig as LibrarySandboxRuntimeConfig,
  SandboxManager,
} from '@anthropic-ai/sandbox-runtime'
import { which } from 'bun'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import {
  type EmbeddedRuntimeFile,
  embeddedDistributionManifest,
  embeddedRuntimeDigest,
  extractEmbeddedRuntime,
  resolveInstallFile,
} from '../../../shared/embedded-assets.ts'
import {
  WORKER_RUNTIME_ASSETS,
  workerRuntimeAssetPaths,
} from '../../../shared/runtime-assets-in-sandbox.ts'
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
let sandboxOperationTail = Promise.resolve()
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

/** The extracted payload root used by a compiled distribution, when one is running. */
export function extractedSandboxRuntimeRoot(environment: StateEnvironment): string | undefined {
  const manifest = embeddedDistributionManifest()
  if (!manifest) return undefined
  return workerRuntimeAssetPaths(resolveStateRoot(environment), manifest.version, {
    sandboxRuntime: WORKER_RUNTIME_ASSETS.sandboxRuntime,
  })[0]
}

/** Exact extracted assets needed by a worker running from a compiled distribution. */
export function extractedWorkerRuntimeAssetPaths(
  environment: StateEnvironment,
): string[] | undefined {
  const manifest = embeddedDistributionManifest()
  if (!manifest) return undefined
  return workerRuntimeAssetPaths(resolveStateRoot(environment), manifest.version)
}

function diskPayloadPath(relativePath: string): string {
  return join(ROOT, relativePath)
}

function payloads(assets: SandboxRuntimeAssets): SandboxRuntimePayload[] {
  return Object.values(assets)
}

export type RuntimeAvailability = {
  available: boolean
  location: string
  missingSystemDependencies: string[]
  condition: string
  remedy: string
  fixes: string[]
  sandboxProbeUnavailableReason: string | null
}

export type LinuxPackageManager = 'apt' | 'dnf' | 'pacman' | 'unknown'

export type RuntimeAvailabilityFacts = {
  location: string
  runtimePresent: boolean
  sourceCheckout: boolean
  missingSystemDependencies: string[]
  userNamespacesUsable: boolean | null
  bwrapPath: string | null
  bwrapProfileLoaded: boolean
  packageManager: LinuxPackageManager
  sandboxProbeUnavailableReason?: string | null
}

type AvailabilityPorts = {
  readOsRelease?: () => string
  resolveExecutable?: (name: string) => string | null
  readApparmorProfiles?: () => string
  probeUserNamespaces?: (bwrapPath: string, shellPath: string) => boolean | Promise<boolean>
}

const PACKAGES = ['bubblewrap', 'socat', 'ripgrep'] as const

/** Pure distro decision for the host packages required by sandbox-runtime. */
export function packageManagerFromOsRelease(text: string): LinuxPackageManager {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (!match) continue
    fields.set(
      match[1]!,
      match[2]!
        .trim()
        .replace(/^(["'])(.*)\1$/, '$2')
        .toLowerCase(),
    )
  }
  const ids = [fields.get('ID') ?? '', ...(fields.get('ID_LIKE') ?? '').split(/\s+/)].filter(
    Boolean,
  )
  for (const id of ids) {
    if (id === 'debian' || id === 'ubuntu') return 'apt'
    if (id === 'fedora' || id === 'rhel' || id === 'centos') return 'dnf'
    if (id === 'arch') return 'pacman'
  }
  return 'unknown'
}

function missingPackages(errors: string[]): string[] {
  const packages = new Set<string>()
  for (const error of errors) {
    if (/ripgrep|\brg\b/i.test(error)) packages.add('ripgrep')
    if (/bubblewrap|\bbwrap\b/i.test(error)) packages.add('bubblewrap')
    if (/socat/i.test(error)) packages.add('socat')
  }
  return PACKAGES.filter((name) => packages.has(name))
}

function sandboxPackageInstallFix(manager: LinuxPackageManager, packages: string[]): string {
  const names = packages.join(' ')
  if (manager === 'apt') return `sudo apt-get install ${names}`
  if (manager === 'dnf') return `sudo dnf install ${names}`
  if (manager === 'pacman') return `sudo pacman -S ${names}`
  return `install the missing sandbox system packages with the system package manager: ${names}`
}

const BWRAP_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}`

function userNamespaceFixes(facts: RuntimeAvailabilityFacts): string[] {
  if (facts.userNamespacesUsable !== false) return []
  if (facts.bwrapProfileLoaded)
    return [
      'a loaded AppArmor profile named bwrap still blocks the required namespace; run sudo aa-status | grep bwrap and inspect /etc/apparmor.d/bwrap or /usr/share/apparmor/extra-profiles/bwrap-userns-restrict',
    ]
  if (facts.bwrapPath !== '/usr/bin/bwrap')
    return [
      `the documented AppArmor profile covers /usr/bin/bwrap, but bwrap was found at ${facts.bwrapPath ?? 'an unknown path'}; configure an AppArmor profile for that executable path`,
    ]
  return [
    `sudo tee /etc/apparmor.d/bwrap <<'EOF'\n${BWRAP_PROFILE}\nEOF`,
    'sudo systemctl reload apparmor',
  ]
}

/** Pure availability ruling shared by every sandbox-runtime consumer. */
export function classifySandboxRuntimeAvailability(
  facts: RuntimeAvailabilityFacts,
): RuntimeAvailability {
  const missingSystemDependencies = [...facts.missingSystemDependencies]
  const packages = missingPackages(missingSystemDependencies)
  const fixes: string[] = []
  if (packages.length) fixes.push(sandboxPackageInstallFix(facts.packageManager, packages))
  if (!facts.runtimePresent)
    fixes.push(
      facts.sourceCheckout
        ? `install the sandbox runtime at ${facts.location} with bun install, then retry`
        : `reinstall the sandbox runtime at ${facts.location}, then retry`,
    )
  const bwrapMissing = packages.includes('bubblewrap')
  if (!bwrapMissing) fixes.push(...userNamespaceFixes(facts))
  const available =
    facts.runtimePresent &&
    missingSystemDependencies.length === 0 &&
    facts.userNamespacesUsable !== false
  const condition = missingSystemDependencies.length
    ? `missing sandbox system dependencies (${missingSystemDependencies.join(', ')})`
    : facts.userNamespacesUsable === false
      ? 'the Linux sandbox cannot create the required user and network namespaces'
      : 'the sandbox runtime is not installed completely'
  const remedy = `${condition}; ${fixes.join('; ')}`
  return {
    available,
    location: facts.location,
    missingSystemDependencies,
    condition,
    remedy,
    fixes,
    sandboxProbeUnavailableReason: facts.sandboxProbeUnavailableReason ?? null,
  }
}

async function defaultProbeUserNamespaces(
  bwrapPath: string,
  shellPath: string,
  path: string,
): Promise<boolean> {
  const { cleanupBwrapMountPoints, wrapCommandWithSandboxLinux } = await import(
    '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
  )
  const command = await wrapCommandWithSandboxLinux({
    command: 'true',
    needsNetworkRestriction: true,
    writeConfig: { allowOnly: [], denyWithinAllow: [] },
    bwrapPath,
    binShell: shellPath,
  })
  try {
    const result = startBoundedSync([shellPath, '-c', command], {
      budget: 'sandbox-probe',
      env: { PATH: path },
    })
    return result.exitCode === 0
  } finally {
    cleanupBwrapMountPoints()
  }
}

export type SandboxLaunchFailureFacts = {
  platform: NodeJS.Platform
  sandboxKind: 'srt' | 'host'
  turnFailed: boolean
  stderr: string
  launchError: string
}

export type SandboxReadinessRefusal = {
  kind: 'sandbox-readiness'
  signature: string
  evidence: string
}

const SANDBOX_READINESS_SIGNATURE =
  /RTM_NEWADDR|setting up uid map:\s*Permission denied|Sandbox dependencies not available|bubblewrap \(bwrap\) not installed/i

/** Identify only Linux srt failures that host readiness can remedy. */
export function classifySandboxLaunchFailure(
  facts: SandboxLaunchFailureFacts,
): SandboxReadinessRefusal | null {
  if (!facts.turnFailed) return null
  if (facts.platform !== 'linux' || facts.sandboxKind !== 'srt') return null
  const text = `${facts.stderr}\n${facts.launchError}`
  const match = text.match(SANDBOX_READINESS_SIGNATURE)
  if (!match) return null
  const evidence = text
    .split('\n')
    .find((line) => SANDBOX_READINESS_SIGNATURE.test(line))
    ?.trim()
  return { kind: 'sandbox-readiness', signature: match[0]!, evidence: evidence || match[0]! }
}

/** Pure presentation for a classified sandbox launch failure and a fresh host ruling. */
export function renderSandboxReadinessRefusal(
  failure: SandboxReadinessRefusal,
  runtime: RuntimeAvailability,
  originalError: string,
  doctorCommand: string,
): string {
  if (runtime.available) {
    return `sandbox runtime readiness failed: ${failure.signature}; run ${doctorCommand} on this machine`
  }
  const fixes = runtime.fixes.length ? `; ${runtime.fixes.join('; ')}` : ''
  const evidence = originalError.trim() || failure.evidence
  return `sandbox runtime readiness failed; ${runtime.condition}${fixes}\noriginal error: ${evidence}`
}

function profileNamedBwrap(text: string): boolean {
  return text.split('\n').some((line) => /^bwrap(?:\s|$)/.test(line.trim()))
}

async function userNamespaceProbeVerdict(
  linux: boolean,
  bwrapPath: string | null,
  bwrapMissing: boolean,
  resolveExecutable: (name: string) => string | null,
  probe: AvailabilityPorts['probeUserNamespaces'],
): Promise<{ usable: boolean | null; unavailableReason: string | null }> {
  if (!linux || !bwrapPath || bwrapMissing) return { usable: null, unavailableReason: null }
  const shellPath = resolveExecutable('sh') ?? '/bin/sh'
  try {
    const usable = await (probe
      ? probe(bwrapPath, shellPath)
      : defaultProbeUserNamespaces(bwrapPath, shellPath, process.env.PATH ?? '/usr/bin:/bin'))
    return { usable, unavailableReason: null }
  } catch (error) {
    return {
      usable: null,
      unavailableReason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Gather host facts for the one availability ruling used by every caller. */
export async function sandboxRuntimeAvailability(
  environment: StateEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  missingSystemDependencies: string[] = SandboxManager.checkDependencies().errors,
  ports: AvailabilityPorts = {},
): Promise<RuntimeAvailability> {
  const linux = platform === 'linux'
  const resolveExecutable = ports.resolveExecutable ?? ((name) => which(name))
  const bwrapPath = linux ? resolveExecutable('bwrap') : null
  const bwrapMissing = missingPackages(missingSystemDependencies).includes('bubblewrap')
  const probeVerdict = await userNamespaceProbeVerdict(
    linux,
    bwrapPath,
    bwrapMissing,
    resolveExecutable,
    ports.probeUserNamespaces,
  )
  const userNamespacesUsable = probeVerdict.usable
  let bwrapProfileLoaded = false
  if (linux && userNamespacesUsable === false) {
    try {
      bwrapProfileLoaded = profileNamedBwrap(
        (
          ports.readApparmorProfiles ??
          (() => readFileSync('/sys/kernel/security/apparmor/profiles', 'utf8'))
        )(),
      )
    } catch {
      bwrapProfileLoaded = false
    }
  }
  let packageManager: LinuxPackageManager = 'unknown'
  if (linux) {
    try {
      packageManager = packageManagerFromOsRelease(
        (ports.readOsRelease ?? (() => readFileSync('/etc/os-release', 'utf8')))(),
      )
    } catch {
      packageManager = 'unknown'
    }
  }
  const manifest = embeddedDistributionManifest()
  if (!manifest) {
    return classifySandboxRuntimeAvailability({
      location: SRT_LIBRARY,
      runtimePresent: existsSync(SRT_LIBRARY),
      sourceCheckout: true,
      missingSystemDependencies,
      userNamespacesUsable,
      bwrapPath,
      bwrapProfileLoaded,
      packageManager,
      sandboxProbeUnavailableReason: probeVerdict.unavailableReason,
    })
  }
  const assets = sandboxRuntimeAssets(platform, arch)
  const required = payloads(assets)
  return classifySandboxRuntimeAvailability({
    runtimePresent:
      (required.length > 1 || platform === 'darwin') &&
      required.every(
        ({ packagePath }) =>
          resolveInstallFile(packagePath, diskPayloadPath(packagePath)) !== undefined,
      ),
    location: extractedSandboxRuntimeRoot(environment)!,
    sourceCheckout: false,
    missingSystemDependencies,
    userNamespacesUsable,
    bwrapPath,
    bwrapProfileLoaded,
    packageManager,
    sandboxProbeUnavailableReason: probeVerdict.unavailableReason,
  })
}

export function srtInstalled(runtime: RuntimeAvailability): boolean {
  return runtime.available
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
  const root = extractedSandboxRuntimeRoot(environment)!
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

async function serializedSandboxOperation<T>(operation: () => Promise<T>): Promise<T> {
  const preceding = sandboxOperationTail
  let release = () => {}
  sandboxOperationTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await preceding
  try {
    return await operation()
  } finally {
    release()
  }
}

/** Scope SRT's process-env-only temp input to one serialized launch. */
export async function withSandboxTemporaryDirectory<T>(
  temporaryDirectory: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return serializedSandboxOperation(async () => {
    const previous = process.env.CLAUDE_CODE_TMPDIR
    if (temporaryDirectory) process.env.CLAUDE_CODE_TMPDIR = temporaryDirectory
    try {
      return await operation()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR
      else process.env.CLAUDE_CODE_TMPDIR = previous
    }
  })
}

export async function launchWithSandboxRuntime(
  config: LibrarySandboxRuntimeConfig,
  command: string,
  temporaryDirectory?: string,
): Promise<string[]> {
  return withSandboxTemporaryDirectory(temporaryDirectory, async () => {
    const payload = await prepareSandboxRuntimeConfig()
    const configured = { ...config, ...payload }
    if (sandboxInitialized) SandboxManager.updateConfig(configured)
    else {
      await SandboxManager.initialize(configured)
      sandboxInitialized = true
    }
    return (await SandboxManager.wrapWithSandboxArgv(command)).argv
  })
}

export async function resetSandboxRuntime(): Promise<void> {
  await serializedSandboxOperation(async () => {
    if (!sandboxInitialized) return
    await SandboxManager.reset()
    sandboxInitialized = false
  })
}
