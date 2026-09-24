// concern: canon-load-files
/** Knows how to gather harness load facts from disk. Must not know stores, commands, runs, routing, or worktrees. */
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  type CandidateFile,
  claudeImportSpecs,
  CLAUDE_IMPORT_MAX_HOPS,
  type HarnessLoadFacts,
  resolveClaudeImport,
} from './canon-load.ts'
import { canonGitRoot } from './canon-files.ts'

const INSTRUCTION_NAMES = [
  'AGENTS.md',
  'AGENTS.override.md',
  'AGENT.md',
  'Agents.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'Claude.md',
]

type Seen = Set<string>

function missing(path: string, error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function readCandidate(path: string, seen: Seen): CandidateFile | null {
  try {
    const stat = lstatSync(path)
    const symlink = stat.isSymbolicLink()
    const followed = statSync(path)
    if (!followed.isFile()) return null
    const realPath = realPathOf(path)
    if (!realPath) return null
    if (seen.has(realPath)) return null
    seen.add(realPath)
    return { path: resolve(path), text: readFileSync(path, 'utf8'), symlink, realPath }
  } catch (error) {
    if (missing(path, error)) return null
    return null
  }
}

function pushCandidate(files: CandidateFile[], path: string, seen: Seen): void {
  const file = readCandidate(path, seen)
  if (file) files.push(file)
}

function walkMarkdown(dir: string, recursive: boolean, seen: Seen, files: CandidateFile[]): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const dirReal = realPathOf(dir)
  if (dirReal) {
    if (seen.has(`dir:${dirReal}`)) return
    seen.add(`dir:${dirReal}`)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        directory = statSync(full).isDirectory()
      } catch {
        continue
      }
    }
    if (directory) {
      if (recursive) walkMarkdown(full, true, seen, files)
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    pushCandidate(files, full, seen)
  }
}

function directoryChain(root: string, cwd: string): string[] {
  const rel = relative(root, cwd)
  if (rel.startsWith('..')) {
    throw new Error(`--cwd ${cwd} is not inside repository ${root}`)
  }
  const chain = [root]
  if (rel === '') return chain
  let current = root
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    chain.push(current)
  }
  return chain
}

function collectNamedFiles(dirs: string[], names: string[], seen: Seen, files: CandidateFile[]): void {
  for (const dir of dirs) {
    for (const name of names) pushCandidate(files, join(dir, name), seen)
  }
}

function collectImportTargets(files: CandidateFile[], seen: Seen): void {
  const queue: { file: CandidateFile; depth: number }[] = []
  for (const file of files) {
    const name = basename(file.path)
    if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || name === 'Claude.md') {
      queue.push({ file, depth: 0 })
    }
  }
  for (const item of queue) {
    if (item.depth >= CLAUDE_IMPORT_MAX_HOPS) continue
    for (const spec of claudeImportSpecs(item.file.text)) {
      const targetPath = resolveClaudeImport(item.file.path, spec)
      const existing = files.find(
        (file) => file.path === targetPath || file.realPath === targetPath,
      )
      if (existing) {
        queue.push({ file: existing, depth: item.depth + 1 })
        continue
      }
      const added = readCandidate(targetPath, seen)
      if (!added) continue
      files.push(added)
      queue.push({ file: added, depth: item.depth + 1 })
    }
  }
}

function envEnabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== '0'
}

export function gatherHarnessLoadFacts(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessLoadFacts {
  let resolvedCwd: string
  try {
    resolvedCwd = realpathSync(resolve(cwd))
  } catch (error) {
    if (missing(cwd, error)) throw new Error(`--cwd ${cwd} does not exist`)
    throw error
  }
  const root = realpathSync(canonGitRoot(resolvedCwd))
  const chain = directoryChain(root, resolvedCwd)
  const home = env.HOME
  if (!home) throw new Error('HOME is unset; set HOME to the user home directory')
  const claudeHome = join(home, '.claude')
  const grokHome = join(home, '.grok')
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(home, '.codex')
  const files: CandidateFile[] = []
  const seen: Seen = new Set()
  collectNamedFiles([claudeHome], ['CLAUDE.md', 'Claude.md'], seen, files)
  collectNamedFiles([grokHome], ['AGENTS.md'], seen, files)
  collectNamedFiles([codexHome], ['AGENTS.override.md', 'AGENTS.md'], seen, files)
  collectNamedFiles(chain, INSTRUCTION_NAMES, seen, files)
  walkMarkdown(join(claudeHome, 'rules'), true, seen, files)
  walkMarkdown(join(root, '.claude', 'rules'), true, seen, files)
  walkMarkdown(join(root, '.grok', 'rules'), true, seen, files)
  walkMarkdown(join(root, '.cursor', 'rules'), true, seen, files)
  collectImportTargets(files, seen)
  return {
    files,
    directoryChain: chain,
    home: { claude: resolve(claudeHome), grok: resolve(grokHome), codex: resolve(codexHome) },
    env: {
      grokClaudeAgentsEnabled: envEnabled(env, 'GROK_CLAUDE_AGENTS_ENABLED'),
      grokClaudeRulesEnabled: envEnabled(env, 'GROK_CLAUDE_RULES_ENABLED'),
    },
  }
}
