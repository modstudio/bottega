// concern: canon-load
/** Knows how each harness plans session-start file load. Must not know filesystems, stores, commands, or processes. */
import { basename, dirname, join, normalize, sep } from 'node:path'

/** Combined always-on character budget matching the Claude Code startup notice on 1M-context models. */
export const CLAUDE_COMBINED_NOTICE_CHARS = 150000
export const CODEX_PROJECT_DOC_MAX_BYTES = 32768
export const CLAUDE_IMPORT_MAX_HOPS = 4
/** Claude Code skips a CLAUDE.md larger than this; every harness read uses the same cap. */
export const CLAUDE_FILE_MAX_BYTES = 4194304
export const HARNESS_NAMES = ['claude', 'codex', 'grok'] as const

export type HarnessName = (typeof HARNESS_NAMES)[number]
type LoadKind = 'always-on' | 'conditional'
type LoadStatus = 'ok' | 'over' | 'truncated'
type LoadUnit = 'chars' | 'bytes'

const CLAUDE_INSTRUCTION_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'Claude.md'] as const
export const CLAUDE_USER_BASENAMES = ['CLAUDE.md'] as const
export const CLAUDE_PROJECT_BASENAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] as const
export const CODEX_USER_BASENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const
export const CODEX_PROJECT_BASENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const
export const GROK_USER_BASENAMES = ['AGENTS.md', 'Claude.md', 'CLAUDE.md'] as const
export const GROK_PROJECT_BASENAMES = [
  'AGENTS.md',
  'Agents.md',
  'AGENT.md',
  'CLAUDE.md',
  'Claude.md',
  'CLAUDE.local.md',
] as const

export type CandidateFile = {
  path: string
  text: string
  symlink: boolean
  realPath: string
  skipped?: { byteSize: number }
}

export type HarnessLoadFacts = {
  files: CandidateFile[]
  directoryChain: string[]
  home: { claude: string; grok: string; codex: string }
  env: { grokClaudeAgentsEnabled: boolean; grokClaudeRulesEnabled: boolean }
}

type LoadedFile = {
  path: string
  size: number
  kind: LoadKind
  reason: string
  external: boolean
  loadedSize?: number
}

type LoadCut = { path: string; omitted: number }

type SkippedFile = {
  path: string
  size: number
  reason: string
}

export type LoadPlan = {
  harness: HarnessName
  files: LoadedFile[]
  total: number
  limit: number | null
  unit: LoadUnit
  status: LoadStatus
  cut: LoadCut[]
  skipped: SkippedFile[]
}

const OVERSIZE_SKIP_REASON = 'exceeds CLAUDE_FILE_MAX_BYTES'

type Builder = {
  facts: HarnessLoadFacts
  harness: HarnessName
  byPath: Map<string, CandidateFile>
  loaded: Map<string, LoadedFile>
  skipped: Map<string, SkippedFile>
  unit: LoadUnit
}

function identity(file: CandidateFile): string {
  return file.realPath || file.path
}

function fileSize(file: CandidateFile, unit: LoadUnit): number {
  return unit === 'bytes' ? Buffer.byteLength(file.text, 'utf8') : file.text.length
}

function isUnderRoot(path: string, root: string): boolean {
  const base = normalize(root)
  const target = normalize(path)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

function harnessHomes(facts: HarnessLoadFacts, harness: HarnessName): string[] {
  if (harness === 'claude') return [facts.home.claude]
  if (harness === 'codex') return [facts.home.codex]
  return [facts.home.grok, facts.home.claude]
}

function isExternalFile(
  file: CandidateFile,
  facts: HarnessLoadFacts,
  harness: HarnessName,
): boolean {
  const real = file.realPath || file.path
  const root = facts.directoryChain[0]
  if (root && isUnderRoot(real, root)) return false
  return !harnessHomes(facts, harness).some((home) => isUnderRoot(real, home))
}

function oversizeSkip(file: CandidateFile): SkippedFile | null {
  if (!file.skipped) return null
  return { path: file.path, size: file.skipped.byteSize, reason: OVERSIZE_SKIP_REASON }
}

function indexFiles(files: CandidateFile[]): Map<string, CandidateFile> {
  const byPath = new Map<string, CandidateFile>()
  for (const file of files) byPath.set(normalize(file.path), file)
  return byPath
}

function findAt(byPath: Map<string, CandidateFile>, dir: string, name: string) {
  return byPath.get(normalize(join(dir, name)))
}

function filesUnder(files: CandidateFile[], dir: string, recursive: boolean): CandidateFile[] {
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return files.filter((file) => {
    if (!file.path.startsWith(prefix) || !file.path.endsWith('.md')) return false
    const rel = file.path.slice(prefix.length)
    return recursive || !rel.includes(sep)
  })
}

function hasPathsKey(text: string): boolean {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  return match ? /^paths:/m.test(match[1]!) : false
}

function ruleKind(text: string, respectPaths: boolean): LoadKind {
  return respectPaths && hasPathsKey(text) ? 'conditional' : 'always-on'
}

function ruleReason(kind: LoadKind, scope: string): string {
  return kind === 'conditional' ? `${scope} rule with paths:` : `${scope} rule`
}

export function isClaudeInstructionName(path: string): boolean {
  return (CLAUDE_INSTRUCTION_NAMES as readonly string[]).includes(basename(path))
}

export function claudeImportSpecs(text: string): string[] {
  const specs: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^@([^\s]+)$/)
    if (!match) continue
    const spec = match[1]!
    if (spec.startsWith('http://') || spec.startsWith('https://')) continue
    specs.push(spec)
  }
  return specs
}

export function resolveClaudeImport(fromPath: string, spec: string): string {
  const trimmed = spec.replace(/^['"]|['"]$/g, '')
  if (trimmed.startsWith('/')) return normalize(trimmed)
  return normalize(join(dirname(fromPath), trimmed))
}

function lookup(builder: Builder, path: string): CandidateFile | undefined {
  const direct = builder.byPath.get(normalize(path))
  if (direct) return direct
  return builder.facts.files.find((file) => file.realPath === path)
}

function add(builder: Builder, file: CandidateFile, kind: LoadKind, reason: string): boolean {
  const id = identity(file)
  if (builder.loaded.has(id) || builder.skipped.has(id)) return false
  const skipped = oversizeSkip(file)
  if (skipped) {
    builder.skipped.set(id, skipped)
    return false
  }
  builder.loaded.set(id, {
    path: file.path,
    size: fileSize(file, builder.unit),
    kind,
    reason,
    external: isExternalFile(file, builder.facts, builder.harness),
  })
  return true
}

function followClaudeImports(builder: Builder, origin: CandidateFile): void {
  const queue: { file: CandidateFile; depth: number }[] = [{ file: origin, depth: 0 }]
  const queued = new Set<string>([identity(origin)])
  for (const item of queue) {
    if (item.depth >= CLAUDE_IMPORT_MAX_HOPS) continue
    for (const spec of claudeImportSpecs(item.file.text)) {
      const target = lookup(builder, resolveClaudeImport(item.file.path, spec))
      if (!target) continue
      const id = identity(target)
      if (queued.has(id)) continue
      queued.add(id)
      add(builder, target, 'always-on', `@import from ${item.file.path}`)
      queue.push({ file: target, depth: item.depth + 1 })
    }
  }
}

function addClaudeInstruction(builder: Builder, file: CandidateFile, reason: string): void {
  if (!add(builder, file, 'always-on', reason)) return
  if (isClaudeInstructionName(file.path)) followClaudeImports(builder, file)
}

function addRuleTree(
  builder: Builder,
  dir: string,
  recursive: boolean,
  respectPaths: boolean,
  scope: string,
): void {
  for (const file of filesUnder(builder.facts.files, dir, recursive)) {
    const kind = ruleKind(file.text, respectPaths)
    add(builder, file, kind, ruleReason(kind, scope))
  }
}

function finishPlan(
  builder: Builder,
  harness: HarnessName,
  limit: number | null,
  statusFor: (alwaysOnTotal: number) => LoadStatus,
  cut: LoadCut[] = [],
): LoadPlan {
  const files = [...builder.loaded.values()]
  const alwaysOnTotal = files
    .filter((file) => file.kind === 'always-on')
    .reduce((sum, file) => sum + (file.loadedSize ?? file.size), 0)
  return {
    harness,
    files,
    total: alwaysOnTotal,
    limit,
    unit: builder.unit,
    status: statusFor(alwaysOnTotal),
    cut,
    skipped: [...builder.skipped.values()],
  }
}

function planClaudeLoad(facts: HarnessLoadFacts): LoadPlan {
  const builder: Builder = {
    facts,
    harness: 'claude',
    byPath: indexFiles(facts.files),
    loaded: new Map(),
    skipped: new Map(),
    unit: 'chars',
  }
  const userClaude = findAt(builder.byPath, facts.home.claude, 'CLAUDE.md')
  if (userClaude) addClaudeInstruction(builder, userClaude, 'user CLAUDE.md')
  addRuleTree(builder, join(facts.home.claude, 'rules'), true, true, 'user')
  for (const dir of facts.directoryChain) {
    const claude = findAt(builder.byPath, dir, 'CLAUDE.md')
    const local = findAt(builder.byPath, dir, 'CLAUDE.local.md')
    const agents = findAt(builder.byPath, dir, 'AGENTS.md')
    if (claude) addClaudeInstruction(builder, claude, 'project CLAUDE.md')
    else if (agents) add(builder, agents, 'always-on', 'project AGENTS.md (no CLAUDE.md)')
    if (local) addClaudeInstruction(builder, local, 'project CLAUDE.local.md')
  }
  const root = facts.directoryChain[0]
  if (root) addRuleTree(builder, join(root, '.claude', 'rules'), true, true, 'project')
  return finishPlan(builder, 'claude', CLAUDE_COMBINED_NOTICE_CHARS, (total) =>
    total > CLAUDE_COMBINED_NOTICE_CHARS ? 'over' : 'ok',
  )
}

function planCodexProjectFiles(
  facts: HarnessLoadFacts,
  byPath: Map<string, CandidateFile>,
): CandidateFile[] {
  const files: CandidateFile[] = []
  const seen = new Set<string>()
  for (const dir of facts.directoryChain) {
    const chosen = findAt(byPath, dir, 'AGENTS.override.md') ?? findAt(byPath, dir, 'AGENTS.md')
    if (!chosen) continue
    const id = identity(chosen)
    if (seen.has(id)) continue
    seen.add(id)
    files.push(chosen)
  }
  return files
}

function takeCodexBytes(
  file: CandidateFile,
  remaining: number,
  reason: string,
  facts: HarnessLoadFacts,
): { loaded: LoadedFile; cut: LoadCut | null; used: number } {
  const size = Buffer.byteLength(file.text, 'utf8')
  const external = isExternalFile(file, facts, 'codex')
  if (remaining <= 0) {
    return {
      loaded: { path: file.path, size, kind: 'always-on', reason, external, loadedSize: 0 },
      cut: { path: file.path, omitted: size },
      used: 0,
    }
  }
  if (size <= remaining) {
    return {
      loaded: { path: file.path, size, kind: 'always-on', reason, external },
      cut: null,
      used: size,
    }
  }
  return {
    loaded: {
      path: file.path,
      size,
      kind: 'always-on',
      reason: `${reason} (truncated)`,
      external,
      loadedSize: remaining,
    },
    cut: { path: file.path, omitted: size - remaining },
    used: remaining,
  }
}

function planCodexLoad(facts: HarnessLoadFacts): LoadPlan {
  const byPath = indexFiles(facts.files)
  const files: LoadedFile[] = []
  const cut: LoadCut[] = []
  const skipped: SkippedFile[] = []
  const user =
    findAt(byPath, facts.home.codex, 'AGENTS.override.md') ??
    findAt(byPath, facts.home.codex, 'AGENTS.md')
  if (user) {
    const oversize = oversizeSkip(user)
    if (oversize) skipped.push(oversize)
    else {
      const name = basename(user.path) === 'AGENTS.override.md' ? 'AGENTS.override.md' : 'AGENTS.md'
      files.push({
        path: user.path,
        size: Buffer.byteLength(user.text, 'utf8'),
        kind: 'always-on',
        reason: `user ${name}`,
        external: isExternalFile(user, facts, 'codex'),
      })
    }
  }
  let remaining = CODEX_PROJECT_DOC_MAX_BYTES
  let projectLoaded = 0
  for (const file of planCodexProjectFiles(facts, byPath)) {
    const oversize = oversizeSkip(file)
    if (oversize) {
      skipped.push(oversize)
      continue
    }
    const name = basename(file.path) === 'AGENTS.override.md' ? 'AGENTS.override.md' : 'AGENTS.md'
    const taken = takeCodexBytes(file, remaining, `project ${name}`, facts)
    remaining -= taken.used
    projectLoaded += taken.used
    if (taken.used > 0) files.push(taken.loaded)
    if (taken.cut) cut.push(taken.cut)
  }
  return {
    harness: 'codex',
    files,
    total: projectLoaded,
    limit: CODEX_PROJECT_DOC_MAX_BYTES,
    unit: 'bytes',
    status: cut.length ? 'truncated' : 'ok',
    cut,
    skipped,
  }
}

function planGrokLoad(facts: HarnessLoadFacts): LoadPlan {
  const builder: Builder = {
    facts,
    harness: 'grok',
    byPath: indexFiles(facts.files),
    loaded: new Map(),
    skipped: new Map(),
    unit: 'chars',
  }
  const userGrok = findAt(builder.byPath, facts.home.grok, 'AGENTS.md')
  if (userGrok) add(builder, userGrok, 'always-on', 'user AGENTS.md')
  if (facts.env.grokClaudeAgentsEnabled) {
    const userClaude =
      findAt(builder.byPath, facts.home.claude, 'Claude.md') ??
      findAt(builder.byPath, facts.home.claude, 'CLAUDE.md')
    if (userClaude) add(builder, userClaude, 'always-on', 'user Claude-compat')
  }
  for (const dir of facts.directoryChain) {
    for (const name of GROK_PROJECT_BASENAMES) {
      const file = findAt(builder.byPath, dir, name)
      if (file) add(builder, file, 'always-on', `project ${basename(file.path)}`)
    }
  }
  const root = facts.directoryChain[0]
  if (root) {
    addRuleTree(builder, join(root, '.grok', 'rules'), false, false, 'project grok')
    if (facts.env.grokClaudeRulesEnabled) {
      addRuleTree(builder, join(root, '.claude', 'rules'), false, false, 'project claude')
    }
    addRuleTree(builder, join(root, '.cursor', 'rules'), false, false, 'project cursor')
  }
  return finishPlan(builder, 'grok', null, () => 'ok')
}

export function planHarnessLoad(facts: HarnessLoadFacts, harness: HarnessName): LoadPlan {
  if (harness === 'claude') return planClaudeLoad(facts)
  if (harness === 'codex') return planCodexLoad(facts)
  return planGrokLoad(facts)
}
