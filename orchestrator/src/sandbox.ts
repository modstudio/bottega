import {
  existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync,
} from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ROOT } from './db.ts'
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
  '~/.ssh',
  '~/.aws',
  '~/.claude/.env',
  '~/.config/gcloud',
  '~/Library/Keychains/login.keychain',
  '~/Library/Keychains/login.keychain-db',
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
  return /\bdocker(?:\s+compose)?\b/i.test(notes ?? '')
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
}): SandboxRuntimeConfig {
  const toolchain = (input.path ?? process.env.PATH ?? '')
    .split(delimiter).filter(Boolean).map((path) => resolve(path))
  const vendorDomains = input.agent === 'grok'
    ? ['cli-chat-proxy.grok.com', 'auth.x.ai', 'api.x.ai']
    : input.agent === 'qwen-local' ? localHost(input.localBaseUrl ?? '') : []
  return {
    network: {
      allowedDomains: [...new Set([
        ...vendorDomains, 'localhost', '127.0.0.1', '[::1]',
      ])],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [
        ...READONLY_LENS_DENY_PATHS.map(expandHome),
        ...resolveSecretPaths(input.project),
        '/var/run/docker.sock',
        '/run/docker.sock',
      ],
      allowRead: [...new Set([
        resolve(input.worktree),
        resolve(input.runsDir),
        ...toolchain,
        ...(input.nodeModuleLinks ?? linkedNodeModules(input.worktree)).map((path) => resolve(path)),
        join(homedir(), '.claude.json'),
      ])],
      allowWrite: [resolve(input.worktree), resolve(input.runsDir)],
      denyWrite: [],
    },
  }
}

export type SandboxSelection = {
  sandbox: RunSandbox
  profile: SandboxRuntimeConfig | null
  reason: string | null
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
}): SandboxSelection {
  if (input.agent === 'codex' || !input.readsRepo || input.writesRepo || !input.worktree || !input.project) {
    return { sandbox: 'host', profile: null, reason: null }
  }
  if (input.override === 'host') {
    return { sandbox: 'host', profile: null, reason: 'ORCH_SANDBOX=host' }
  }
  if (readonlyNeedsDocker(input.readonlyNotes)) {
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
    }),
  }
}

export function srtInstalled(): boolean {
  return existsSync(SRT_BIN)
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
    for (const name of ['auth.json', 'config.toml']) {
      const source = join(homedir(), '.grok', name)
      const target = join(runDir, name)
      if (existsSync(source) && !existsSync(target)) symlinkSync(source, target)
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
