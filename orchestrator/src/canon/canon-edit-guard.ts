// concern: canon-edit-guard
/** Knows the pure pre-edit canon decision. Must not know filesystems, stores, commands, or processes. */
import { isAbsolute, posix, relative, resolve } from 'node:path'
import { BASH_WRITE_ESCAPES, bashWriteTargets } from './canon-edit-bash.ts'
import type { TranscriptEvent } from './canon-edit-transcript.ts'

export const CANON_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'] as const
export const CANON_COMPACT_MATCHER = 'compact'

export type EnforcedContext = { path: string; description: string; globs: string[] }
export type CanonEditDecision = { allow: true } | { allow: false; reason: string }

const CANON_PATH = /(?:^|\/)\.agents(?:\/|$)|(?:^|\/)(?:AGENTS|CLAUDE)\.md$/

export function failOpenCanonEdit(reason: string): { allow: true; warning: string } {
  return { allow: true, warning: `canon-edit-guard: allowed unchecked — ${reason}` }
}

function toolTargets(tool: string, input: unknown): string[] {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (tool === 'Bash')
    return typeof fields.command === 'string' ? bashWriteTargets(fields.command) : []
  const target = tool === 'NotebookEdit' ? fields.notebook_path : fields.file_path
  return typeof target === 'string' ? [target] : []
}

export function normalizedRepoPath(target: string, cwd: string, root: string): string | null {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
  const path = relative(root, absolute).split('\\').join('/')
  if (path === '' || path === '..' || path.startsWith('../') || isAbsolute(path)) return null
  return posix.normalize(path)
}

function contextAliases(context: EnforcedContext): string[] {
  const name = posix.basename(context.path)
  return [context.path, `.claude/rules/${name}`, `.claude/rules/contexts/${name}`]
}

function readPaths(events: TranscriptEvent[], cwd: string, root: string): Set<string> {
  const calls = new Map<string, string>()
  const results = new Set<string>()
  for (const event of events) {
    if (event.kind === 'tool_use' && event.name === 'Read') {
      const input = event.input as { file_path?: unknown } | undefined
      if (typeof input?.file_path === 'string') calls.set(event.id, input.file_path)
    } else if (event.kind === 'tool_result' && event.content && !event.error)
      results.add(event.toolUseId)
  }
  return new Set(
    [...calls]
      .filter(([id]) => results.has(id))
      .flatMap(([, path]) => [
        normalizedRepoPath(path, cwd, root),
        normalizedRepoPath(path, root, root),
      ])
      .filter((path): path is string => path !== null),
  )
}

function matches(path: string, context: EnforcedContext): boolean {
  return context.globs.some((glob) => {
    if (path === glob) return true
    const matcher = new Bun.Glob(glob)
    return matcher.match(path) || matcher.match(`${path}/`)
  })
}

function denyMessage(contexts: EnforcedContext[], targets: string[]): string {
  const required = contexts.map((context) => `- ${context.description}: ${context.path}`).join('\n')
  return `Canon guard: ${targets.join(', ')} requires path-scoped canon that has not been read:\n${required}\nUse the Read tool on each exact path in THIS session; a subagent must read it in its own session. Then retry the same call. Bash does not bypass this guard. Deliberately unresolved Bash escapes are ${BASH_WRITE_ESCAPES.join(', ')}.`
}

/** Decide one pre-edit call from supplied facts only. */
export function decideCanonEdit(input: {
  managedContext: boolean
  tool: string
  toolInput: unknown
  cwd: string
  repoRoot: string
  contexts: EnforcedContext[]
  events: TranscriptEvent[]
}): CanonEditDecision {
  if (!input.managedContext || !CANON_EDIT_TOOLS.some((tool) => tool === input.tool))
    return { allow: true }
  const read = readPaths(input.events, input.cwd, input.repoRoot)
  const needed = new Map<string, EnforcedContext>()
  const blocked: string[] = []
  for (const target of toolTargets(input.tool, input.toolInput)) {
    const path = normalizedRepoPath(target, input.cwd, input.repoRoot)
    if (path === null || CANON_PATH.test(path)) continue
    const missing = input.contexts.filter(
      (context) =>
        matches(path, context) && !contextAliases(context).some((alias) => read.has(alias)),
    )
    if (missing.length === 0) continue
    blocked.push(path)
    for (const context of missing) needed.set(context.path, context)
  }
  return needed.size === 0
    ? { allow: true }
    : { allow: false, reason: denyMessage([...needed.values()], blocked) }
}

/** Paths named by earlier edit calls, used only for the compact reminder. */
export function transcriptWriteTargets(events: TranscriptEvent[]): Array<{ cwdTarget: string }> {
  return events.flatMap((event) =>
    event.kind === 'tool_use' && CANON_EDIT_TOOLS.some((tool) => tool === event.name)
      ? toolTargets(event.name, event.input).map((cwdTarget) => ({ cwdTarget }))
      : [],
  )
}

export function contextsCoveringTargets(input: {
  targets: string[]
  cwd: string
  repoRoot: string
  contexts: EnforcedContext[]
}): EnforcedContext[] {
  const touched = new Map<string, EnforcedContext>()
  for (const target of input.targets) {
    const path = normalizedRepoPath(target, input.cwd, input.repoRoot)
    if (path === null || CANON_PATH.test(path)) continue
    for (const context of input.contexts.filter((candidate) => matches(path, candidate))) {
      touched.set(context.path, context)
    }
  }
  return [...touched.values()]
}
