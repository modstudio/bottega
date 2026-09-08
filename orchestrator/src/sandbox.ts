import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ROOT } from './db.ts'
import { mcpEndpointAllowlist } from './mcp-probe.ts'
import type { Project } from './projects.ts'

export type SandboxRuntimeConfig = {
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowUnixSockets: string[]
    allowLocalBinding: boolean
  }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

export type RunSandbox = 'host' | 'srt'

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
export const READONLY_LENS_DENY_SOCKETS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
] as const

export const SRT_BIN = join(ROOT, 'node_modules', '.bin', 'srt')

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export function resolveSecretPaths(project: Project): string[] {
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
export function linkedNodeModules(worktree: string): string[] {
  const found = new Set<string>()
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.claude') continue
      const path = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        try {
          if (lstatSync(path).isSymbolicLink()) found.add(realpathSync(path))
        } catch { /* a broken link is not a readable dependency root */ }
        continue
      }
      if (entry.isDirectory()) visit(path, depth + 1)
    }
  }
  visit(worktree, 0)
  return [...found].sort()
}

export function readonlyNeedsDocker(notes: string | undefined): boolean {
  return /(?:\b(?:need|needs|require|requires|must use)\b.{0,80}\bdocker\b|\bdocker\b.{0,80}\b(?:needed|required|must be used)\b|\brun\b.{0,40}\b(?:checks?|tests?)\b.{0,40}\b(?:with|in|via)\s+docker\b)/is
    .test(notes ?? '')
}

function localHost(baseUrl: string): string[] {
  if (!baseUrl) return []
  try { return [new URL(baseUrl).hostname] } catch { return [] }
}

export function readonlyLensProfile(input: {
  worktree: string
  runsDir: string
  project: Project
  agent: string
  path?: string
  localBaseUrl?: string
  nodeModuleLinks?: string[]
  mcpEndpoint?: string | null
}): SandboxRuntimeConfig {
  const toolchain = (input.path ?? process.env.PATH ?? '')
    .split(delimiter).filter(Boolean).map((path) => resolve(path))
  const vendorDomains = input.agent === 'grok'
    ? ['cli-chat-proxy.grok.com', 'auth.x.ai', 'api.x.ai']
    : input.agent === 'qwen-local' ? localHost(input.localBaseUrl ?? '') : []
  const worktree = resolve(input.worktree)
  const runsDir = resolve(input.runsDir)
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
  const candidateAllows = [...new Set([
    worktree,
    runsDir,
    ...toolchain,
    ...(input.nodeModuleLinks ?? linkedNodeModules(input.worktree)).map((path) => resolve(path)),
    join(homedir(), '.claude.json'),
    process.execPath,
    ROOT,
  ])]
  const allowRead = candidateAllows.filter((allowed) =>
    !protectedDenies.some((denied) => isAtOrBelow(allowed, denied)))
  return {
    network: {
      allowedDomains: [...new Set([
        ...vendorDomains, 'localhost', '127.0.0.1', '[::1]',
        ...mcpEndpointAllowlist(input.mcpEndpoint),
      ])],
      deniedDomains: [],
      allowUnixSockets: [],
      // On macOS srt's one switch covers both binding and outbound loopback.
      // The per-run orch-ask listener uses an OS-assigned loopback port, so it
      // cannot be named in the static domain list before srt starts.
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: [
        ...protectedDenies,
        ...READONLY_LENS_DENY_SOCKETS,
      ],
      allowRead,
      allowWrite: [worktree, runsDir],
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
  project: Project | null
  readonlyNotes?: string
  override?: string
  path?: string
  localBaseUrl?: string
  mcpEndpoint?: string | null
}): SandboxSelection {
  if (!isReadonlySandboxCandidate(input)) {
    return { sandbox: 'host', profile: null, reason: null }
  }
  if (input.override === 'host') {
    return {
      sandbox: 'host', profile: null,
      reason: input.readsRepo ? 'ORCH_SANDBOX=host' : null,
    }
  }
  if (!input.worktree) {
    throw new Error(
      `${input.readsRepo ? 'readonly repository' : 'no-repo'} sandbox refusal: ` +
      'the sandbox root is missing',
    )
  }
  if (!input.project) {
    throw new Error(
      `${input.readsRepo ? 'readonly repository' : 'no-repo'} sandbox refusal: ` +
      'the launch directory does not resolve to a registered project',
    )
  }
  if (input.readsRepo && readonlyNeedsDocker(input.readonlyNotes)) {
    return {
      sandbox: 'host', profile: null,
      reason: 'project worktree.readonly_notes says read-only checks need Docker',
    }
  }
  return {
    sandbox: 'srt', reason: null,
    profile: readonlyLensProfile({
      worktree: input.worktree, runsDir: input.runsDir, project: input.project,
      agent: input.agent, path: input.path, localBaseUrl: input.localBaseUrl,
      mcpEndpoint: input.mcpEndpoint,
    }),
  }
}

export function srtInstalled(): boolean {
  return existsSync(SRT_BIN)
}

/** Persist one profile and wrap a vendor argv without leaking srt's CLI grammar into run.ts. */
export function srtLaunchArgv(
  profile: SandboxRuntimeConfig,
  settingsPath: string,
  bin: string,
  argv: string[],
): string[] {
  writeFileSync(settingsPath, JSON.stringify(profile, null, 2))
  return [SRT_BIN, '--settings', settingsPath, '--', bin, ...argv]
}

/** Keep Grok's registered stdio shape while making a linked-worktree build test its own proxy. */
export function grokSandboxConfig(config: string): string {
  const section = /(\[mcp_servers\.orch-ask\]\s*\n[\s\S]*?)(?=\n\[|$)/
  return config.replace(section, (body) => body
    .replace(/(\bcommand\s*=\s*)"[^"]+"/, `$1${JSON.stringify(Bun.which('bun') ?? process.execPath)}`)
    .replace(/(\bargs\s*=\s*\[\s*)"[^"]+"/, `$1${JSON.stringify(join(ROOT, 'src', 'ask-proxy.ts'))}`))
}

/**
 * Put vendor session state under this run's writable directory without copying
 * long-lived credentials into retained run evidence. Grok follows its official
 * GROK_HOME override; Qwen follows HOME and receives only its non-secret user
 * settings as read-only links.
 */
export function prepareSandboxHome(
  agent: string, runDir: string,
): Record<string, string> {
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
