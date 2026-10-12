import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { inspectionGitEnv } from '../git'
import type { ChangeFacts, LineRange } from '../ratchet'

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C'

export type ChangeEntry = {
  status: ChangeStatus
  path: string
  sourcePath?: string
}

export type ContentResult = { status: 'present'; text: string } | { status: 'absent' }

export type ChangeViewMode = 'commit' | 'staged'

function parseStatus(value: string): ChangeStatus {
  const status = value[0]
  if (status === 'A' || status === 'M' || status === 'D' || status === 'R' || status === 'C') {
    return status
  }
  throw new Error(`unsupported git name-status entry: ${value || '(empty)'}`)
}

export function parseNameStatus(text: string): ChangeEntry[] {
  if (!text) return []
  const fields = text.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const entries: ChangeEntry[] = []

  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++]
    if (rawStatus === undefined) break
    const status = parseStatus(rawStatus)
    if (status === 'R' || status === 'C') {
      const sourcePath = fields[index++]
      const path = fields[index++]
      if (sourcePath === undefined || path === undefined) {
        throw new Error(`incomplete git ${status} name-status entry`)
      }
      entries.push({ status, path, sourcePath })
      continue
    }
    const path = fields[index++]
    if (path === undefined) throw new Error(`incomplete git ${status} name-status entry`)
    entries.push({ status, path })
  }

  return entries
}

function decodeQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escapes: Record<string, number> = {
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
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!
    if (character !== '\\') {
      const codePoint = value.codePointAt(index)!
      const literal = String.fromCodePoint(codePoint)
      bytes.push(...encoder.encode(literal))
      if (literal.length === 2) index++
      continue
    }
    const escaped = value[++index]
    if (escaped === undefined) throw new Error('incomplete quoted git path')
    if (escaped in escapes) {
      bytes.push(escapes[escaped]!)
      continue
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? '')) octal += value[++index]
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    bytes.push(...encoder.encode(escaped))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function patchPath(header: string): string | null {
  const value = decodeQuotedPath(header.slice(4))
  if (value === '/dev/null') return null
  return value.startsWith('b/') ? value.slice(2) : value
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
    const match = /\+(\d+)(?:,(\d+))?/.exec(line)
    if (!match) throw new Error(`invalid git hunk header: ${line}`)
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (path === undefined) throw new Error('git hunk appeared before its head path')
    if (path === null || count === 0) continue
    const ranges = addedLines.get(path) ?? []
    ranges.push({ start, end: start + count - 1 })
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

function diffArgs(base: string, mode: ChangeViewMode, format: string[]): string[] {
  const comparison = mode === 'staged' ? ['--cached', base] : [base, 'HEAD']
  return ['diff', ...format, '--diff-filter=ACMRD', '-M', ...comparison]
}

function committedContent(cwd: string, commit: string, path: string): ContentResult {
  git(cwd, ['cat-file', '-e', `${commit}^{commit}`])
  const entry = git(cwd, ['ls-tree', '-z', commit, '--', path])
  if (!entry) return { status: 'absent' }
  return { status: 'present', text: git(cwd, ['cat-file', 'blob', `${commit}:${path}`]) }
}

function indexedContent(cwd: string, path: string): ContentResult {
  const entry = git(cwd, ['ls-files', '--stage', '-z', '--', path])
  if (!entry) return { status: 'absent' }
  return { status: 'present', text: git(cwd, ['show', `:${path}`]) }
}

function materializedPath(directory: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`cannot materialize absolute git path: ${path}`)
  const target = resolve(directory, path)
  if (relative(directory, target).startsWith('..')) {
    throw new Error(`cannot materialize git path outside the temporary directory: ${path}`)
  }
  return target
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
  const entries = parseNameStatus(git(cwd, diffArgs(base, mode, ['--name-status', '-z'])))
  const facts = changeFacts(
    entries,
    parseAddedLines(git(cwd, diffArgs(base, mode, ['--unified=0']))),
  )

  const baseContent = (path: string) => committedContent(cwd, base, facts.renames.get(path) ?? path)
  const headContent = (path: string) =>
    mode === 'commit' ? committedContent(cwd, 'HEAD', path) : indexedContent(cwd, path)

  return {
    entries,
    facts,
    baseContent,
    headContent,
    materializeBase(paths: string[]) {
      const directory = mkdtempSync(join(tmpdir(), 'bottega-change-base-'))
      const absent: string[] = []
      const location = relative(resolve(cwd), directory)
      if (!location.startsWith('..') && !isAbsolute(location)) {
        rmSync(directory, { recursive: true, force: true })
        throw new Error('temporary directory for base content resolved inside the checkout')
      }
      try {
        for (const headPath of paths) {
          const basePath = facts.renames.get(headPath) ?? headPath
          const content = baseContent(headPath)
          if (content.status === 'absent') {
            absent.push(headPath)
            continue
          }
          const target = materializedPath(directory, basePath)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, content.text)
        }
      } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
      }
      return {
        directory,
        absent,
        dispose: () => rmSync(directory, { recursive: true, force: true }),
      }
    },
  }
}
