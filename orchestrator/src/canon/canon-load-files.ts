// concern: canon-load-files
/** Knows how to gather harness load facts from disk. Must not know stores, commands, runs, routing, or worktrees. */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { canonGitRoot } from './canon-files.ts'
import {
  type CandidateFile,
  CLAUDE_IMPORT_MAX_HOPS,
  claudeImportSpecs,
  type HarnessLoadFacts,
  resolveClaudeImport,
} from './canon-load.ts'

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

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function readCandidate(path: string, seen: Seen, uniqueReal = true): CandidateFile | null {
  try {
    const stat = lstatSync(path)
    const symlink = stat.isSymbolicLink()
    const followed = statSync(path)
    if (!followed.isFile()) return null
    const realPath = realPathOf(path)
    if (!realPath) return null
    if (uniqueReal && seen.has(realPath)) return null
    seen.add(realPath)
    return { path: resolve(path), text: readFileSync(path, 'utf8'), symlink, realPath }
  } catch (error) {
    if (missing(error)) return null
    return null
  }
}

function pushCandidate(files: CandidateFile[], path: string, seen: Seen, uniqueReal = true): void {
  const file = readCandidate(path, seen, uniqueReal)
  if (file) files.push(file)
}

function claimWalkDir(dir: string, seen: Seen): boolean {
  const dirReal = realPathOf(dir)
  if (!dirReal) return true
  if (seen.has(`dir:${dirReal}`)) return false
  seen.add(`dir:${dirReal}`)
  return true
}

function direntIsDirectory(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  full: string,
) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(full).isDirectory()
  } catch {
    return null
  }
}

function readDirents(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

function walkMarkdown(dir: string, recursive: boolean, seen: Seen, files: CandidateFile[]): void {
  const entries = readDirents(dir)
  if (!entries) return
  if (!claimWalkDir(dir, seen)) return
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const directory = direntIsDirectory(entry, full)
    if (directory === null) continue
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

function collectNamedFiles(
  dirs: string[],
  names: string[],
  seen: Seen,
  files: CandidateFile[],
): void {
  for (const dir of dirs) {
    for (const name of names) pushCandidate(files, join(dir, name), seen, false)
  }
}

function collectImportTargets(files: CandidateFile[], seen: Seen): void {
  const queue: { file: CandidateFile; depth: number }[] = []
  const queued = new Set<string>()
  const enqueue = (file: CandidateFile, depth: number) => {
    const id = file.realPath || file.path
    const key = `${id}:${depth}`
    if (queued.has(key)) return
    queued.add(key)
    queue.push({ file, depth })
  }
  for (const file of files) {
    const name = basename(file.path)
    if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md' || name === 'Claude.md') {
      enqueue(file, 0)
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
        enqueue(existing, item.depth + 1)
        continue
      }
      const added = readCandidate(targetPath, seen)
      if (!added) continue
      files.push(added)
      enqueue(added, item.depth + 1)
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
    if (missing(error)) throw new Error(`--cwd ${cwd} does not exist`)
    throw error
  }
  const root = realpathSync(canonGitRoot(resolvedCwd))
  const chain = directoryChain(root, resolvedCwd)
  const home = env.HOME
  if (!home) throw new Error('HOME is unset; set HOME to the user home directory')
  const claudeHome = resolve(home, '.claude')
  const grokHome = resolve(home, '.grok')
  const codexHome =
    env.CODEX_HOME && env.CODEX_HOME.length > 0 ? resolve(env.CODEX_HOME) : resolve(home, '.codex')
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
