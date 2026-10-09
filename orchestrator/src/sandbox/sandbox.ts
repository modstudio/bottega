// concern: readonly sandbox policy and its sandbox-runtime adapter; must not know run control, worktrees, or CLI grammar.
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import type { SandboxRuntimeConfig as LibrarySandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { type ConfigEnvironment, resolveEnvFilePaths } from '../../../shared/config-directory.ts'
import { embeddedDistributionManifest } from '../../../shared/embedded-assets.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import {
  ensureHubLoginTokenDirectory,
  hubLoginTokenDirectory,
} from '../../../shared/state-directory.ts'
import { ROOT } from '../database/db.ts'
import { disabledProjectMcpServers } from '../mcp/mcp-probe.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { launchWithSandboxRuntime, resetSandboxRuntime } from './sandbox-runtime.ts'

export type SandboxRuntimeConfig = {
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowUnixSockets: string[]
    allowLocalBinding: boolean
  }
  filesystem: {
    denyRead: string[]
    /** Paths allowed back inside denyRead entries; reads are otherwise allow-by-default. */
    allowWithinDeny: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

export type RunSandbox = 'host' | 'srt'

/** Operator env file denied by every readonly-lens profile. */
const READONLY_LENS_OPERATOR_ENV_FILE = '~/.claude/.env'

/** Login keychain paths denied by every readonly-lens profile. */
const READONLY_LENS_LOGIN_KEYCHAIN_PATHS = [
  '~/Library/Keychains/login.keychain',
  '~/Library/Keychains/login.keychain-db',
] as const

/** Sensitive operator paths denied by every readonly-lens profile. */
export const READONLY_LENS_DENY_PATHS = [
  '~/.ssh', // private SSH keys and host credentials
  '~/.aws', // AWS access keys and session credentials
  READONLY_LENS_OPERATOR_ENV_FILE, // MCP and service tokens
  '~/.config/gcloud', // Google Cloud application credentials
  ...READONLY_LENS_LOGIN_KEYCHAIN_PATHS,
] as const

/**
 * Host-control sockets are denied for every read-only worker.
 */
export const READONLY_LENS_DENY_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'] as const

/** Loopback TCP is allowed on every readonly-lens SRT profile. */
export const READONLY_LENS_ALLOW_LOCAL_BINDING = true

/** Reads denied by every SRT profile, including profiles outside normal runs. */
function mandatorySrtDenyRead(environment: ConfigEnvironment = process.env): string[] {
  return [
    ...READONLY_LENS_DENY_PATHS.map(expandHome).map((path) => resolve(path)),
    hubLoginTokenDirectory(environment),
  ]
}

/** Construct an SRT profile while preserving the mandatory read denials. */
export function createSandboxRuntimeConfig(
  profile: SandboxRuntimeConfig,
  environment: ConfigEnvironment = process.env,
): SandboxRuntimeConfig {
  return {
    ...profile,
    filesystem: {
      ...profile.filesystem,
      denyRead: [
        ...new Set([...mandatorySrtDenyRead(environment), ...profile.filesystem.denyRead]),
      ],
    },
  }
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export function resolveSecretPaths(project: Project | null): string[] {
  if (!project) return []
  return (project.settings.secretPaths ?? []).map((entry) => {
    const expanded = expandHome(entry)
    return isAbsolute(expanded) ? resolve(expanded) : resolve(project.path, expanded)
  })
}

const isAtOrBelow = (path: string, parent: string) => {
  const fromParent = relative(parent, path)
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent))
}

function denyReadCovers(denyRead: readonly string[], path: string): boolean {
  return denyRead.some((denied) => isAtOrBelow(path, denied))
}

function readonlyLensOperatorEnvFileDenyPaths(envFilePaths: readonly string[]): string[] {
  return [...new Set(envFilePaths.map((path) => resolve(path)))]
}

function readonlyLensLoginKeychainDenyPaths(keychainPaths: readonly string[]): string[] {
  return [...new Set(keychainPaths.map((path) => resolve(path)))]
}

/** Whether a readonly-lens denyRead list denies the operator env file. */
export function readonlyLensDeniesOperatorEnvFile(
  denyRead: readonly string[],
  envFilePaths: readonly string[],
): boolean {
  return readonlyLensOperatorEnvFileDenyPaths(envFilePaths).some((path) =>
    denyReadCovers(denyRead, path),
  )
}

/** Whether a readonly-lens denyRead list denies the login keychain. */
export function readonlyLensDeniesLoginKeychain(
  denyRead: readonly string[],
  keychainPaths: readonly string[],
): boolean {
  return readonlyLensLoginKeychainDenyPaths(keychainPaths).some((path) =>
    denyReadCovers(denyRead, path),
  )
}

function protectedDenyPaths(project: Project | null, environment: ConfigEnvironment): string[] {
  return [
    ...new Set([
      ...mandatorySrtDenyRead(environment),
      ...readonlyLensOperatorEnvFileDenyPaths(resolveEnvFilePaths(environment)),
      ...readonlyLensLoginKeychainDenyPaths(READONLY_LENS_LOGIN_KEYCHAIN_PATHS.map(expandHome)),
      ...resolveSecretPaths(project),
    ]),
  ]
}

/** Resolved deny lists a confinement report needs; the report itself reads no home. */
export function readonlyLensReportInputs(
  environment: ConfigEnvironment,
  project: Project | null = null,
): {
  denyRead: readonly string[]
  envFilePaths: string[]
  keychainPaths: string[]
} {
  return {
    denyRead: [...protectedDenyPaths(project, environment), ...READONLY_LENS_DENY_SOCKETS],
    envFilePaths: readonlyLensOperatorEnvFileDenyPaths([
      expandHome(READONLY_LENS_OPERATOR_ENV_FILE),
      ...resolveEnvFilePaths(environment),
    ]),
    keychainPaths: readonlyLensLoginKeychainDenyPaths(
      READONLY_LENS_LOGIN_KEYCHAIN_PATHS.map(expandHome),
    ),
  }
}

function refuseProtectedOverlap(
  label: string,
  protectedDenies: readonly string[],
  worktree: string,
  runsDir: string,
): void {
  for (const denied of protectedDenies) {
    if (isAtOrBelow(denied, worktree) || isAtOrBelow(worktree, denied)) {
      throw new Error(
        `${label} sandbox refusal: a registered secret path cannot be inside the worktree (${denied})`,
      )
    }
    if (isAtOrBelow(denied, runsDir)) {
      throw new Error(
        `${label} sandbox refusal: a registered secret path cannot be inside the run directory (${denied})`,
      )
    }
    if (isAtOrBelow(runsDir, denied)) {
      throw new Error(
        `${label} sandbox refusal: a registered secret path cannot contain the run directory (${denied})`,
      )
    }
  }
}

/**
 * Find dependency roots linked from the disposable checkout into its main
 * checkout. Only directory entries named node_modules are followed; arbitrary
 * symlinks are not promoted into sandbox read grants.
 */
function linkedNodeModules(worktree: string): string[] {
  const found = new Set<string>()
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.claude') continue
      const path = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        try {
          if (lstatSync(path).isSymbolicLink()) found.add(realpathSync(path))
        } catch {
          /* a broken link is not a readable dependency root */
        }
        continue
      }
      if (entry.isDirectory()) visit(path, depth + 1)
    }
  }
  visit(worktree, 0)
  return [...found].sort()
}

function localHost(baseUrl: string): string[] {
  if (!baseUrl) return []
  try {
    return [new URL(baseUrl).hostname]
  } catch {
    return []
  }
}

export function readonlyLensProfile(input: {
  worktree: string
  runsDir: string
  scratchDir?: string
  project: Project | null
  agent: string
  path?: string
  localBaseUrl?: string
  nodeModuleLinks?: string[]
  mcpAllowlist?: string[]
  environment?: ConfigEnvironment
}): SandboxRuntimeConfig {
  const environment = input.environment ?? process.env
  const toolchain = (input.path ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((path) => resolve(path))
  const vendorDomains =
    input.agent === 'grok'
      ? ['cli-chat-proxy.grok.com', 'auth.x.ai', 'api.x.ai']
      : input.agent === 'qwen36-qwencli'
        ? localHost(input.localBaseUrl ?? '')
        : []
  const worktree = resolve(input.worktree)
  const runsDir = resolve(input.runsDir)
  const scratchDir = input.scratchDir ? resolve(input.scratchDir) : null
  const protectedDenies = protectedDenyPaths(input.project, environment)
  refuseProtectedOverlap('readonly-lens', protectedDenies, worktree, runsDir)
  const candidateAllows = [
    ...new Set([
      worktree,
      runsDir,
      ...toolchain,
      ...(input.nodeModuleLinks ?? linkedNodeModules(input.worktree)).map((path) => resolve(path)),
      join(homedir(), '.claude.json'),
      process.execPath,
      ...(embeddedDistributionManifest() ? [] : [ROOT]),
    ]),
  ]
  // SRT reads are allow-by-default. This list only carves paths back out of
  // denyRead; it is not, and must not be read as, a read confinement boundary.
  const allowWithinDeny = candidateAllows.filter(
    (allowed) => !protectedDenies.some((denied) => isAtOrBelow(allowed, denied)),
  )
  return createSandboxRuntimeConfig(
    {
      network: {
        allowedDomains: [
          ...new Set([
            ...vendorDomains,
            'localhost',
            '127.0.0.1',
            '[::1]',
            ...(input.mcpAllowlist ?? []),
          ]),
        ],
        deniedDomains: [],
        allowUnixSockets: [],
        // On macOS srt's one switch covers both binding and outbound loopback.
        // The per-run orch-ask listener uses an OS-assigned loopback port, so it
        // cannot be named in the static domain list before srt starts.
        allowLocalBinding: READONLY_LENS_ALLOW_LOCAL_BINDING,
      },
      filesystem: {
        denyRead: [...protectedDenies, ...READONLY_LENS_DENY_SOCKETS],
        allowWithinDeny,
        allowWrite: [...new Set([worktree, runsDir, ...(scratchDir ? [scratchDir] : [])])],
        denyWrite: [],
      },
    },
    environment,
  )
}

/** Write-deny everywhere except a throwaway directory; no network; no secret paths. */
export function probeSandboxProfile(input: {
  allowWriteDir: string
  cwd: string
  project: Project
  environment?: ConfigEnvironment
}): SandboxRuntimeConfig {
  const allowWrite = resolve(input.allowWriteDir)
  const cwd = resolve(input.cwd)
  const protectedDenies = protectedDenyPaths(input.project, input.environment ?? process.env)
  refuseProtectedOverlap('probe', protectedDenies, cwd, allowWrite)
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [...new Set([...protectedDenies, ...READONLY_LENS_DENY_SOCKETS])],
      allowWithinDeny: [],
      allowWrite: [allowWrite],
      denyWrite: [],
    },
  }
}

export function probeSandboxProfileForCwd(input: {
  allowWriteDir: string
  cwd: string
  database: Parameters<typeof projectAt>[1]
}): SandboxRuntimeConfig {
  const project = projectAt(input.cwd, input.database)
  if (!project) throw new Error(`orch workflow probe: no registered project contains ${input.cwd}`)
  return probeSandboxProfile({
    allowWriteDir: input.allowWriteDir,
    cwd: input.cwd,
    project,
  })
}

export type SandboxSelection = {
  sandbox: RunSandbox
  profile: SandboxRuntimeConfig | null
  reason: string | null
}

export function isReadonlySandboxCandidate(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
}): boolean {
  return input.agent !== 'codex' && !input.writesRepo
}

export type ReadonlySandboxKind = {
  sandbox: RunSandbox
  reason: string | null
  missingRoot: boolean
}

/** Host-versus-srt decision dispatch uses before it builds an SRT profile. */
export function selectReadonlySandboxKind(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
  worktreePresent: boolean
  projectPresent: boolean
  override?: string
  mcp?: boolean
}): ReadonlySandboxKind {
  if (!isReadonlySandboxCandidate(input)) {
    return { sandbox: 'host', reason: null, missingRoot: false }
  }
  // Preserve the repository seam exactly: an unregistered or not-yet-cut
  // readonly checkout was already a host run. No-repo jobs have no such
  // fallback because their isolate is the boundary this selector must build.
  if (input.readsRepo && (!input.worktreePresent || !input.projectPresent)) {
    return { sandbox: 'host', reason: null, missingRoot: false }
  }
  if (input.override === 'host') {
    return {
      sandbox: 'host',
      reason: input.readsRepo
        ? 'ORCH_SANDBOX=host'
        : 'ORCH_SANDBOX=host skipped the no-repo isolate sandbox; run is unconfined',
      missingRoot: false,
    }
  }
  if (input.mcp) {
    return {
      sandbox: 'host',
      reason: 'MCP was requested; srt blocks MCP transports; run is unconfined',
      missingRoot: false,
    }
  }
  if (!input.worktreePresent) {
    return { sandbox: 'srt', reason: null, missingRoot: true }
  }
  return { sandbox: 'srt', reason: null, missingRoot: false }
}

export function selectReadonlySandbox(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
  worktree: string | null
  runsDir: string
  scratchDir?: string
  project: Project | null
  override?: string
  path?: string
  localBaseUrl?: string
  mcp?: boolean
  mcpAllowlist?: string[]
  environment?: ConfigEnvironment
}): SandboxSelection {
  const kind = selectReadonlySandboxKind({
    agent: input.agent,
    readsRepo: input.readsRepo,
    writesRepo: input.writesRepo,
    worktreePresent: Boolean(input.worktree),
    projectPresent: Boolean(input.project),
    override: input.override,
    mcp: input.mcp,
  })
  if (kind.missingRoot) {
    throw new Error(
      `${input.readsRepo ? 'readonly repository' : 'no-repo'} sandbox refusal: ` +
        'the sandbox root is missing',
    )
  }
  if (kind.sandbox !== 'srt') {
    return { sandbox: kind.sandbox, profile: null, reason: kind.reason }
  }
  return {
    sandbox: 'srt',
    reason: kind.reason,
    profile: readonlyLensProfile({
      worktree: input.worktree!,
      runsDir: input.runsDir,
      scratchDir: input.scratchDir,
      project: input.project,
      agent: input.agent,
      path: input.path,
      localBaseUrl: input.localBaseUrl,
      mcpAllowlist: input.mcpAllowlist,
      environment: input.environment,
    }),
  }
}

/** Translate orch's policy vocabulary to the maintained runtime's configuration. */
export function sandboxRuntimeConfig(profile: SandboxRuntimeConfig): LibrarySandboxRuntimeConfig {
  const { allowWithinDeny, ...filesystem } = profile.filesystem
  return {
    ...profile,
    filesystem: {
      denyRead: filesystem.denyRead,
      allowRead: allowWithinDeny,
      allowWrite: filesystem.allowWrite,
      denyWrite: filesystem.denyWrite,
    },
  }
}

/** Quote argv into the command input that sandbox-runtime wraps behind an argv shell launch; mirrors the runtime's unexported utils/shell-quote so the srt CLI and this adapter re-parse identically. */
function shellCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      if (arg === '') return "''"
      if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) return arg
      return `'${arg.replaceAll("'", `'"'"'`)}'`
    })
    .join(' ')
}

/** Initialize the run-scoped manager and return an argv-safe sandbox launch. */
export async function sandboxLaunchArgv(
  profile: SandboxRuntimeConfig,
  bin: string,
  argv: string[],
): Promise<string[]> {
  ensureHubLoginTokenDirectory(process.env)
  const config = sandboxRuntimeConfig(profile)
  return launchWithSandboxRuntime(config, shellCommand([bin, ...argv]))
}

/** Release the process-scoped runtime resources provisioned for this run. */
export async function resetSandbox(): Promise<void> {
  await resetSandboxRuntime()
}

const ORCH_ASK_TOML_TABLE = 'mcp_servers.orch-ask'

function tomlTableName(line: string): string | null {
  return /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line)?.[1] ?? null
}

function isOrchAskTable(name: string): boolean {
  return name === ORCH_ASK_TOML_TABLE || name.startsWith(`${ORCH_ASK_TOML_TABLE}.`)
}

/** Remove any user-registered orch-ask table and its subtables. */
export function withoutRegisteredOrchAskServer(config: string): string {
  const kept: string[] = []
  let inAskTable = false
  for (const line of config.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []) {
    const table = tomlTableName(line)
    if (table) inAskTable = isOrchAskTable(table)
    if (!inAskTable) kept.push(line)
  }
  return kept.join('')
}

/** Read the argv from the same Grok table that the run-home writer owns. */
export function grokAskCommandFromConfig(config: string): string[] {
  const lines = config.split(/\r?\n/)
  const start = lines.findIndex((line) => tomlTableName(line) === ORCH_ASK_TOML_TABLE)
  if (start < 0) throw new Error('Grok config has no mcp_servers.orch-ask table')
  const following = lines.slice(start + 1)
  const end = following.findIndex((line) => tomlTableName(line) !== null)
  const section = end < 0 ? following : following.slice(0, end)
  const value = (key: string): unknown => {
    const match = section.find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))
    if (!match) return undefined
    return JSON.parse(match.slice(match.indexOf('=') + 1).trim())
  }
  const command = value('command')
  const args = value('args') ?? []
  if (
    typeof command !== 'string' ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string')
  ) {
    throw new Error('Grok orch-ask command or args are malformed')
  }
  return [command, ...args]
}

/**
 * Replace any user-registered orch-ask table (and its subtables) with one built
 * from the running binary. Grok reads orch-ask only from its config file, and a
 * one-time registration goes stale when the entrypoint moves or bun is upgraded.
 */
function withLiveGrokAskServer(config: string, command: string[]): string {
  const kept = withoutRegisteredOrchAskServer(config)
  const section = [
    '[mcp_servers.orch-ask]',
    `command = ${JSON.stringify(command[0])}`,
    `args = ${JSON.stringify(command.slice(1))}`,
    'enabled = true',
  ].join('\n')
  return `${kept.trimEnd()}\n\n${section}\n`
}

/** Choose the Grok orch-ask command from the sandbox this turn launches in. */
export function grokAskServerCommand(sandbox: RunSandbox): string[] {
  return bottegaEntryArgv(sandbox === 'srt' ? 'ask-proxy' : 'ask-server')
}

/** Point a Grok run's orch-ask at the command for its launch sandbox. */
export function grokSandboxConfig(config: string, sandbox: RunSandbox): string {
  return withLiveGrokAskServer(config, grokAskServerCommand(sandbox))
}

/** Prepare the MCP home and visible scope line only for Grok. */
export function prepareProjectGrokMcpScope(
  agent: string,
  runDir: string,
  names: string[],
  allowed: string[] | undefined,
  header: string | null,
  sandbox: RunSandbox,
): { environment: Record<string, string>; header: string | null } {
  if (agent !== 'grok') return { environment: {}, header }
  const disabled = disabledProjectMcpServers(names, allowed)
  const line = disabled.length
    ? `MCP scope: withheld ${disabled.join(', ')} (not in workerMcpServers)`
    : null
  return {
    environment: prepareGrokMcpHome(runDir, disabled, join(homedir(), '.grok'), sandbox),
    header: header && line ? `${header}\n${line}` : (header ?? line),
  }
}

/** Prepare Grok's host-run MCP state without copying its long-lived credential. */
export function prepareGrokMcpHome(
  runDir: string,
  disabled: string[],
  source: string,
  sandbox: RunSandbox,
): Record<string, string> {
  ensurePrivateDirectory(runDir)
  const authSource = join(source, 'auth.json')
  const authTarget = join(runDir, 'auth.json')
  if (existsSync(authSource) && !existsSync(authTarget)) symlinkSync(authSource, authTarget)

  const configTarget = join(runDir, 'config.toml')
  let config: string
  if (!existsSync(configTarget)) {
    const configSource = join(source, 'config.toml')
    config = existsSync(configSource) ? readFileSync(configSource, 'utf8') : ''
    const topLevel = config.split(/^\s*\[/m, 1)[0] ?? ''
    if (/^\s*disabled_mcp_servers\s*=/m.test(topLevel)) {
      throw new Error(`disabled_mcp_servers is already declared in ${configSource}`)
    }
    config = `disabled_mcp_servers = ${JSON.stringify(disabled)}\n\n${config}`
  } else {
    config = readFileSync(configTarget, 'utf8')
  }
  writeFileSync(configTarget, grokSandboxConfig(config, sandbox), {
    mode: 0o600,
  })
  chmodSync(configTarget, 0o600)
  return { GROK_HOME: runDir, GROK_DISABLE_AUTOUPDATER: '1' }
}

function prepareGrokSandboxHome(
  runDir: string,
  operatorHome: string,
  sandbox: RunSandbox,
): Record<string, string> {
  ensurePrivateDirectory(runDir)
  const authSource = join(operatorHome, '.grok', 'auth.json')
  const authTarget = join(runDir, 'auth.json')
  if (existsSync(authSource) && !existsSync(authTarget)) symlinkSync(authSource, authTarget)

  const configSource = join(operatorHome, '.grok', 'config.toml')
  const configTarget = join(runDir, 'config.toml')
  const config = existsSync(configTarget)
    ? readFileSync(configTarget, 'utf8')
    : existsSync(configSource)
      ? readFileSync(configSource, 'utf8')
      : ''
  writeFileSync(configTarget, grokSandboxConfig(config, sandbox), {
    mode: 0o600,
  })
  chmodSync(configTarget, 0o600)
  return { GROK_HOME: runDir, GROK_DISABLE_AUTOUPDATER: '1' }
}

const OMITTED_WORKER_HOME_ENTRIES = new Set(['.claude', '.claude.json', '.codex', '.grok'])

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`worker home refusal: ${path} is not an owned directory; remove it and retry`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && entry.uid !== uid) {
    throw new Error(
      `worker home refusal: ${path} is not owned by the current user; fix ownership and retry`,
    )
  }
  chmodSync(path, 0o700)
}

function isWithin(path: string, parent: string): boolean {
  const fromParent = relative(parent, path)
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent))
}

function exposesOmittedWorkerSource(path: string, operatorHome: string): boolean {
  let real: string
  let realOperatorHome: string
  try {
    real = realpathSync(path)
    realOperatorHome = realpathSync(operatorHome)
  } catch {
    return false
  }
  for (const name of OMITTED_WORKER_HOME_ENTRIES) {
    if (isWithin(real, resolve(realOperatorHome, name))) return true
  }
  try {
    return readdirSync(real).some((name) => OMITTED_WORKER_HOME_ENTRIES.has(name))
  } catch {
    return false
  }
}

/** Mirror ordinary operator tooling into a chain home without exposing harness canon. */
export function prepareWorkerHomeMirror(runDir: string, operatorHome: string): string {
  const targetHome = join(runDir, 'home')
  let entries: string[]
  try {
    entries = readdirSync(operatorHome)
  } catch (error) {
    throw new Error(
      `worker HOME refusal: could not list ${operatorHome}: ${String((error as Error).message ?? error)}; set HOME to a readable operator home and retry`,
    )
  }
  ensurePrivateDirectory(runDir)
  ensurePrivateDirectory(targetHome)
  const targetClaudeHome = join(targetHome, '.claude')
  ensurePrivateDirectory(targetClaudeHome)
  const sourceClaudeEnv = join(operatorHome, '.claude', '.env')
  const sourceClaudeEnvEntry = lstatSync(sourceClaudeEnv, { throwIfNoEntry: false })
  const targetClaudeEnv = join(targetClaudeHome, '.env')
  const targetClaudeEnvEntry = lstatSync(targetClaudeEnv, { throwIfNoEntry: false })
  if (sourceClaudeEnvEntry?.isFile()) {
    if (
      !targetClaudeEnvEntry?.isSymbolicLink() ||
      readlinkSync(targetClaudeEnv) !== sourceClaudeEnv
    ) {
      if (targetClaudeEnvEntry) rmSync(targetClaudeEnv, { recursive: true, force: true })
      symlinkSync(sourceClaudeEnv, targetClaudeEnv)
    }
  } else if (targetClaudeEnvEntry) {
    rmSync(targetClaudeEnv, { recursive: true, force: true })
  }
  for (const name of entries) {
    if (OMITTED_WORKER_HOME_ENTRIES.has(name)) continue
    if (exposesOmittedWorkerSource(join(operatorHome, name), operatorHome)) continue
    const target = join(targetHome, name)
    if (!pathEntryExists(target)) symlinkSync(join(operatorHome, name), target)
  }
  return targetHome
}

function codexConfigRefusal(path: string): Error {
  return new Error(
    `Codex worker home refusal: ${path} is not a regular non-symlink file owned by this user; remove the run's Codex home and retry`,
  )
}

function secureCodexConfig(configSource: string, configTarget: string): void {
  const expected = lstatSync(configTarget, { throwIfNoEntry: false })
  if (!expected) {
    const config = withoutRegisteredOrchAskServer(readFileSync(configSource, 'utf8'))
    let descriptor: number
    try {
      descriptor = openSync(
        configTarget,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
    } catch {
      throw codexConfigRefusal(configTarget)
    }
    try {
      writeFileSync(descriptor, config)
      fchmodSync(descriptor, 0o600)
    } finally {
      closeSync(descriptor)
    }
    return
  }

  const userId = process.getuid?.()
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    userId === undefined ||
    expected.uid !== userId
  )
    throw codexConfigRefusal(configTarget)

  let descriptor: number
  try {
    descriptor = openSync(configTarget, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw codexConfigRefusal(configTarget)
  }
  try {
    const opened = fstatSync(descriptor)
    if (
      !opened.isFile() ||
      opened.uid !== userId ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw codexConfigRefusal(configTarget)
    fchmodSync(descriptor, 0o600)
  } finally {
    closeSync(descriptor)
  }
}

/** Prepare one persistent Codex home for every turn in a conversation chain. */
export function prepareCodexHome(
  runDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const operatorHome = environment.HOME
  const source = environment.CODEX_HOME
    ? resolve(environment.CODEX_HOME)
    : operatorHome
      ? join(resolve(operatorHome), '.codex')
      : null
  if (!source) {
    throw new Error(
      'Codex worker home refusal: HOME and CODEX_HOME are unset; set HOME to the operator home or CODEX_HOME to the authenticated Codex home and retry',
    )
  }
  const authSource = join(source, 'auth.json')
  if (!existsSync(authSource)) {
    throw new Error(
      `Codex worker home refusal: ${authSource} is absent; run codex login for that home and retry`,
    )
  }
  const configSource = join(source, 'config.toml')
  if (!existsSync(configSource)) {
    throw new Error(
      `Codex worker home refusal: ${configSource} is absent; create the operator Codex configuration and retry`,
    )
  }
  const targetHome = join(runDir, 'codex')
  ensurePrivateDirectory(runDir)
  ensurePrivateDirectory(targetHome)
  const authTarget = join(targetHome, 'auth.json')
  // Codex rotates refresh tokens, so the chain must share the operator credential file.
  if (!existsSync(authTarget)) symlinkSync(authSource, authTarget)
  const configTarget = join(targetHome, 'config.toml')
  secureCodexConfig(configSource, configTarget)
  return { CODEX_HOME: targetHome }
}

/** Grok's mirrored HOME links the operator env file into the worker home. */
export function workerHomeLinksEnvFile(harness: string): boolean {
  return harness === 'grok'
}

/**
 * Put vendor session state under this chain's writable directory. Codex and
 * Grok receive isolated harness homes; Grok also receives a mirrored HOME that
 * excludes every harness home. Qwen receives only its non-secret user settings.
 */
export function prepareSandboxHome(
  agent: string,
  runDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  sandbox: RunSandbox,
): Record<string, string> {
  if (agent === 'codex') return prepareCodexHome(runDir, environment)
  if (workerHomeLinksEnvFile(agent)) {
    const operatorHome = environment.HOME
    if (!operatorHome) {
      throw new Error(
        'worker HOME refusal: HOME is unset; set HOME to a readable operator home and retry',
      )
    }
    const home = prepareWorkerHomeMirror(runDir, resolve(operatorHome))
    return { ...prepareGrokSandboxHome(runDir, resolve(operatorHome), sandbox), HOME: home }
  }
  if (agent === 'qwen36-qwencli') {
    const qwenDir = join(runDir, '.qwen')
    ensurePrivateDirectory(runDir)
    ensurePrivateDirectory(qwenDir)
    for (const name of ['settings.json', 'output-language.md']) {
      const source = join(homedir(), '.qwen', name)
      const target = join(qwenDir, name)
      if (existsSync(source) && !existsSync(target)) symlinkSync(source, target)
    }
    return { HOME: runDir }
  }
  ensurePrivateDirectory(runDir)
  return {}
}

/** Remove only a chain directory first created by a failed launch attempt. */
export function removeNewSandboxHomeAfterFailure(runDir: string, existedBefore: boolean): void {
  if (!existedBefore) rmSync(runDir, { recursive: true, force: true })
}
