// concern: readonly sandbox policy and its sandbox-runtime adapter; must not know run control, worktrees, or CLI grammar.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import {
  type SandboxRuntimeConfig as LibrarySandboxRuntimeConfig,
  SandboxManager,
} from '@anthropic-ai/sandbox-runtime'
import { ROOT } from '../database/db.ts'
import { disabledProjectMcpServers } from '../mcp/mcp-probe.ts'
import type { Project } from '../project/projects.ts'

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

type RunSandbox = 'host' | 'srt'

/** Sensitive operator paths denied by every readonly-lens profile. */
export const READONLY_LENS_DENY_PATHS = [
  '~/.ssh', // private SSH keys and host credentials
  '~/.aws', // AWS access keys and session credentials
  '~/.claude/.env', // MCP and service tokens
  '~/.config/gcloud', // Google Cloud application credentials
  '~/Library/Keychains/login.keychain', // legacy macOS login keychain
  '~/Library/Keychains/login.keychain-db', // current macOS login keychain
] as const

/** Host-control sockets: Docker access is equivalent to escaping the sandbox. */
export const READONLY_LENS_DENY_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'] as const

export const SRT_LIBRARY = join(
  ROOT,
  'node_modules',
  '@anthropic-ai',
  'sandbox-runtime',
  'dist',
  'index.js',
)
let sandboxInitialized = false

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

export function readonlyNeedsDocker(notes: string | undefined): boolean {
  return /(?:\b(?:need|needs|require|requires|must use)\b.{0,80}\bdocker\b|\bdocker\b.{0,80}\b(?:needed|required|must be used)\b|\brun\b.{0,40}\b(?:checks?|tests?)\b.{0,40}\b(?:with|in|via)\s+docker\b)/is.test(
    notes ?? '',
  )
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
}): SandboxRuntimeConfig {
  const toolchain = (input.path ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((path) => resolve(path))
  const vendorDomains =
    input.agent === 'grok'
      ? ['cli-chat-proxy.grok.com', 'auth.x.ai', 'api.x.ai']
      : input.agent === 'qwen-local'
        ? localHost(input.localBaseUrl ?? '')
        : []
  const worktree = resolve(input.worktree)
  const runsDir = resolve(input.runsDir)
  const scratchDir = input.scratchDir ? resolve(input.scratchDir) : null
  const protectedDenies = [
    ...READONLY_LENS_DENY_PATHS.map(expandHome).map((path) => resolve(path)),
    ...resolveSecretPaths(input.project),
  ]
  const isAtOrBelow = (path: string, parent: string) => {
    const fromParent = relative(parent, path)
    return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent))
  }
  for (const denied of protectedDenies) {
    if (isAtOrBelow(denied, worktree) || isAtOrBelow(worktree, denied)) {
      throw new Error(
        `readonly-lens sandbox refusal: a registered secret path cannot be inside the worktree (${denied})`,
      )
    }
    if (isAtOrBelow(denied, runsDir)) {
      throw new Error(
        `readonly-lens sandbox refusal: a registered secret path cannot be inside the run directory (${denied})`,
      )
    }
    if (isAtOrBelow(runsDir, denied)) {
      throw new Error(
        `readonly-lens sandbox refusal: a registered secret path cannot contain the run directory (${denied})`,
      )
    }
  }
  const candidateAllows = [
    ...new Set([
      worktree,
      runsDir,
      ...toolchain,
      ...(input.nodeModuleLinks ?? linkedNodeModules(input.worktree)).map((path) => resolve(path)),
      join(homedir(), '.claude.json'),
      process.execPath,
      ROOT,
    ]),
  ]
  // SRT reads are allow-by-default. This list only carves paths back out of
  // denyRead; it is not, and must not be read as, a read confinement boundary.
  const allowWithinDeny = candidateAllows.filter(
    (allowed) => !protectedDenies.some((denied) => isAtOrBelow(allowed, denied)),
  )
  return {
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
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: [...protectedDenies, ...READONLY_LENS_DENY_SOCKETS],
      allowWithinDeny,
      allowWrite: [...new Set([worktree, runsDir, ...(scratchDir ? [scratchDir] : [])])],
      denyWrite: [],
    },
  }
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

export function selectReadonlySandbox(input: {
  agent: string
  readsRepo: boolean
  writesRepo: boolean
  worktree: string | null
  runsDir: string
  scratchDir?: string
  project: Project | null
  readonlyNotes?: string
  override?: string
  path?: string
  localBaseUrl?: string
  mcp?: boolean
  mcpAllowlist?: string[]
}): SandboxSelection {
  if (!isReadonlySandboxCandidate(input)) {
    return { sandbox: 'host', profile: null, reason: null }
  }
  // Preserve the repository seam exactly: an unregistered or not-yet-cut
  // readonly checkout was already a host run. No-repo jobs have no such
  // fallback because their isolate is the boundary this selector must build.
  if (input.readsRepo && (!input.worktree || !input.project)) {
    return { sandbox: 'host', profile: null, reason: null }
  }
  if (input.override === 'host') {
    return {
      sandbox: 'host',
      profile: null,
      reason: input.readsRepo
        ? 'ORCH_SANDBOX=host'
        : 'ORCH_SANDBOX=host skipped the no-repo isolate sandbox; run is unconfined',
    }
  }
  if (input.mcp) {
    return {
      sandbox: 'host',
      profile: null,
      reason: 'MCP was requested; srt blocks MCP transports; run is unconfined',
    }
  }
  if (!input.worktree) {
    throw new Error(
      `${input.readsRepo ? 'readonly repository' : 'no-repo'} sandbox refusal: ` +
        'the sandbox root is missing',
    )
  }
  if (input.readsRepo && readonlyNeedsDocker(input.readonlyNotes)) {
    return {
      sandbox: 'host',
      profile: null,
      reason: 'project worktree.readonly_notes says read-only checks need Docker',
    }
  }
  return {
    sandbox: 'srt',
    reason: null,
    profile: readonlyLensProfile({
      worktree: input.worktree,
      runsDir: input.runsDir,
      scratchDir: input.scratchDir,
      project: input.project,
      agent: input.agent,
      path: input.path,
      localBaseUrl: input.localBaseUrl,
      mcpAllowlist: input.mcpAllowlist,
    }),
  }
}

export function srtInstalled(): boolean {
  return existsSync(SRT_LIBRARY)
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

/** Initialise the run-scoped manager and return an argv-safe sandbox launch. */
export async function sandboxLaunchArgv(
  profile: SandboxRuntimeConfig,
  bin: string,
  argv: string[],
): Promise<string[]> {
  const config = sandboxRuntimeConfig(profile)
  if (sandboxInitialized) SandboxManager.updateConfig(config)
  else {
    await SandboxManager.initialize(config)
    sandboxInitialized = true
  }
  return (await SandboxManager.wrapWithSandboxArgv(shellCommand([bin, ...argv]))).argv
}

/** Release the process-scoped runtime resources provisioned for this run. */
export async function resetSandbox(): Promise<void> {
  if (!sandboxInitialized) return
  await SandboxManager.reset()
  sandboxInitialized = false
}

/** Keep Grok's registered stdio shape while making a linked-worktree build test its own proxy. */
export function grokSandboxConfig(config: string): string {
  const section = /(\[mcp_servers\.orch-ask\]\s*\n[\s\S]*?)(?=\n\[|$)/
  return config.replace(section, (body) =>
    body
      .replace(
        /(\bcommand\s*=\s*)"[^"]+"/,
        `$1${JSON.stringify(Bun.which('bun') ?? process.execPath)}`,
      )
      .replace(
        /(\bargs\s*=\s*\[\s*)"[^"]+"/,
        `$1${JSON.stringify(join(ROOT, 'src', 'ask', 'ask-proxy.ts'))}`,
      ),
  )
}

/** Prepare the MCP home and visible scope line only for Grok. */
export function prepareProjectGrokMcpScope(
  agent: string,
  runDir: string,
  names: string[],
  allowed: string[] | undefined,
  header: string | null,
): { environment: Record<string, string>; header: string | null } {
  if (agent !== 'grok') return { environment: {}, header }
  const disabled = disabledProjectMcpServers(names, allowed)
  const line = disabled.length
    ? `MCP scope: withheld ${disabled.join(', ')} (not in workerMcpServers)`
    : null
  return {
    environment: prepareGrokMcpHome(runDir, disabled),
    header: header && line ? `${header}\n${line}` : (header ?? line),
  }
}

/** Prepare Grok's host-run MCP state without copying its long-lived credential. */
export function prepareGrokMcpHome(
  runDir: string,
  disabled: string[],
  source = join(homedir(), '.grok'),
): Record<string, string> {
  mkdirSync(runDir, { recursive: true })
  const authSource = join(source, 'auth.json')
  const authTarget = join(runDir, 'auth.json')
  if (existsSync(authSource) && !existsSync(authTarget)) symlinkSync(authSource, authTarget)

  const configTarget = join(runDir, 'config.toml')
  if (!existsSync(configTarget)) {
    const configSource = join(source, 'config.toml')
    const config = existsSync(configSource) ? readFileSync(configSource, 'utf8') : ''
    const topLevel = config.split(/^\s*\[/m, 1)[0] ?? ''
    if (/^\s*disabled_mcp_servers\s*=/m.test(topLevel)) {
      throw new Error(`disabled_mcp_servers is already declared in ${configSource}`)
    }
    writeFileSync(configTarget, `disabled_mcp_servers = ${JSON.stringify(disabled)}\n\n${config}`)
  }
  return { GROK_HOME: runDir, GROK_DISABLE_AUTOUPDATER: '1' }
}

/**
 * Put vendor session state under this run's writable directory without copying
 * long-lived credentials into retained run evidence. Grok follows its official
 * GROK_HOME override; Qwen follows HOME and receives only its non-secret user
 * settings as read-only links.
 */
export function prepareSandboxHome(agent: string, runDir: string): Record<string, string> {
  mkdirSync(runDir, { recursive: true })
  if (agent === 'grok') {
    const authSource = join(homedir(), '.grok', 'auth.json')
    const authTarget = join(runDir, 'auth.json')
    if (existsSync(authSource) && !existsSync(authTarget)) symlinkSync(authSource, authTarget)

    const configSource = join(homedir(), '.grok', 'config.toml')
    const configTarget = join(runDir, 'config.toml')
    if (existsSync(configSource) && !existsSync(configTarget)) {
      writeFileSync(configTarget, grokSandboxConfig(readFileSync(configSource, 'utf8')))
    }
    return { GROK_HOME: runDir, GROK_DISABLE_AUTOUPDATER: '1' }
  }
  if (agent === 'qwen-local') {
    const qwenDir = join(runDir, '.qwen')
    mkdirSync(qwenDir, { recursive: true })
    for (const name of ['settings.json', 'output-language.md']) {
      const source = join(homedir(), '.qwen', name)
      const target = join(qwenDir, name)
      if (existsSync(source) && !existsSync(target)) symlinkSync(source, target)
    }
    return { HOME: runDir }
  }
  return {}
}
