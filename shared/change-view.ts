import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspectionGitEnv } from './git'
import { nulPathListArgs, splitNulNameStatus, splitNulPaths } from './git-path-list.ts'
import type { ChangeFacts, LineRange } from './ratchet'

type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C'

export type ChangeEntry = {
  status: ChangeStatus
  path: string
  sourcePath?: string
}

export type ContentResult = { status: 'present'; text: string } | { status: 'absent' }

export type ChangeViewMode = 'worktree' | 'staged'

function parseStatus(value: string): ChangeStatus {
  const status = value[0]
  if (status === 'A' || status === 'M' || status === 'D' || status === 'R' || status === 'C') {
    return status
  }
  throw new Error(`unsupported git name-status entry: ${value || '(empty)'}`)
}

export function parseNameStatus(text: string): ChangeEntry[] {
  return splitNulNameStatus(text).map(({ status: rawStatus, path, previousPath }) => {
    const status = parseStatus(rawStatus)
    return previousPath === null ? { status, path } : { status, path, sourcePath: previousPath }
  })
}

export function untrackedChanges(text: string, lineCounts: Map<string, number>) {
  const paths = splitNulPaths(text)
  const entries: ChangeEntry[] = []
  const addedLines = new Map<string, LineRange[]>()
  for (const path of paths) {
    entries.push({ status: 'A', path })
    const lines = lineCounts.get(path) ?? 0
    if (lines > 0) addedLines.set(path, [{ start: 1, end: lines }])
  }
  return { entries, addedLines }
}

const ESCAPED_BYTES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

function decodedEscape(value: string, index: number) {
  const escaped = value[index]
  if (escaped === undefined) throw new Error('incomplete quoted git path')
  if (escaped in ESCAPED_BYTES) return { bytes: [ESCAPED_BYTES[escaped]!], index }
  if (!/[0-7]/.test(escaped)) return { bytes: [...new TextEncoder().encode(escaped)], index }
  let octal = escaped
  while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? '')) octal += value[++index]
  return { bytes: [Number.parseInt(octal, 8)], index }
}

function decodeQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!
    if (character !== '\\') {
      const codePoint = value.codePointAt(index)!
      const literal = String.fromCodePoint(codePoint)
      bytes.push(...encoder.encode(literal))
      if (literal.length === 2) index++
      continue
    }
    const decoded = decodedEscape(value, index + 1)
    bytes.push(...decoded.bytes)
    index = decoded.index
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function patchPath(header: string): string | null {
  const value = decodeQuotedPath(header.slice(4))
  if (value === '/dev/null') return null
  return value.startsWith('b/') ? value.slice(2) : value
}

function addedRange(line: string, path: string | null | undefined): LineRange | null {
  const match = /\+(\d+)(?:,(\d+))?/.exec(line)
  if (!match) throw new Error(`invalid git hunk header: ${line}`)
  if (path === undefined) throw new Error('git hunk appeared before its head path')
  const start = Number(match[1])
  const count = match[2] === undefined ? 1 : Number(match[2])
  return path === null || count === 0 ? null : { start, end: start + count - 1 }
}

export function parseAddedLines(text: string): Map<string, LineRange[]> {
  const addedLines = new Map<string, LineRange[]>()
  let path: string | null | undefined
  let readingHeader = false

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = undefined
      readingHeader = true
      continue
    }
    if (readingHeader && line.startsWith('+++ ')) {
      path = patchPath(line)
      readingHeader = false
      continue
    }
    if (!line.startsWith('@@ ')) continue
    readingHeader = false
    const range = addedRange(line, path)
    if (!range || path === null || path === undefined) continue
    const ranges = addedLines.get(path) ?? []
    ranges.push(range)
    addedLines.set(path, ranges)
  }

  return addedLines
}

export function changeFacts(
  entries: ChangeEntry[],
  addedLines: Map<string, LineRange[]>,
): ChangeFacts {
  const renames = new Map<string, string>()
  for (const entry of entries) {
    if (entry.status === 'R') renames.set(entry.path, entry.sourcePath!)
  }
  return { renames, addedLines }
}

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, '--no-optional-locks', ...args], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || 'no error output'
    throw new Error(
      `could not inspect change with git ${args.join(' ')}: ${detail}. Verify that the commit and its objects exist, then retry.`,
    )
  }
  return result.stdout.toString()
}

/**
 * What each mode compares and where its head content comes from. `worktree` names the
 * base alone, so git compares it with the files on disk; naming `HEAD` as well would
 * hide every uncommitted change from the checks that read this view.
 */
export function changeViewPlan(base: string, mode: ChangeViewMode) {
  const comparison = mode === 'staged' ? ['--cached', base] : [base]
  const diff = (format: string[]) => ['diff', ...format, '--diff-filter=ACMRD', '-M', ...comparison]
  return {
    nameStatus: diff(nulPathListArgs(['--name-status'])),
    patch: diff(['--unified=0']),
    untracked:
      mode === 'worktree' ? nulPathListArgs(['ls-files', '--others', '--exclude-standard']) : null,
    head: mode === 'worktree' ? ('working-tree' as const) : ('index' as const),
  }
}

function committedContent(cwd: string, commit: string, path: string): ContentResult {
  git(cwd, ['cat-file', '-e', `${commit}^{commit}`])
  const entry = git(cwd, ['ls-tree', '-z', commit, '--', path])
  if (!entry) return { status: 'absent' }
  return { status: 'present', text: git(cwd, ['cat-file', 'blob', `${commit}:${path}`]) }
}

function indexedContent(cwd: string, path: string): ContentResult {
  const entry = git(cwd, nulPathListArgs(['ls-files', '--stage', '--', path]))
  if (!entry) return { status: 'absent' }
  return { status: 'present', text: git(cwd, ['show', `:${path}`]) }
}

function workingTreeContent(cwd: string, path: string): ContentResult {
  try {
    return { status: 'present', text: readFileSync(resolve(cwd, path), 'utf8') }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { status: 'absent' }
    }
    throw error
  }
}

function textLineCount(text: string) {
  if (!text) return 0
  return text.split('\n').length - Number(text.endsWith('\n'))
}

export function openChangeView({
  cwd,
  base,
  mode,
}: {
  cwd: string
  base: string
  mode: ChangeViewMode
}) {
  const plan = changeViewPlan(base, mode)
  const trackedEntries = parseNameStatus(git(cwd, plan.nameStatus))
  const trackedAddedLines = parseAddedLines(git(cwd, plan.patch))
  const untracked = plan.untracked
    ? (() => {
        const paths = git(cwd, plan.untracked)
        const lineCounts = new Map<string, number>()
        for (const path of splitNulPaths(paths)) {
          const content = workingTreeContent(cwd, path)
          lineCounts.set(path, content.status === 'present' ? textLineCount(content.text) : 0)
        }
        return untrackedChanges(paths, lineCounts)
      })()
    : { entries: [], addedLines: new Map<string, LineRange[]>() }
  const entries = [...trackedEntries, ...untracked.entries]
  const facts = changeFacts(entries, new Map([...trackedAddedLines, ...untracked.addedLines]))

  const baseContent = (path: string) => committedContent(cwd, base, facts.renames.get(path) ?? path)
  const headContent = (path: string) =>
    plan.head === 'working-tree' ? workingTreeContent(cwd, path) : indexedContent(cwd, path)

  return {
    entries,
    facts,
    baseContent,
    headContent,
  }
}
