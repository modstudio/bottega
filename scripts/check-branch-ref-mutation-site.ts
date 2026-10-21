import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const started = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(root, 'orchestrator', 'src')
const files: string[] = []

function collect(directory: string): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixture.ts')
    ) {
      files.push(path)
    }
  }
}

collect(sourceRoot)

const mutationPatterns = [
  { command: 'update-ref', pattern: /['"]update-ref['"]/g },
  { command: 'worktree', pattern: /['"]worktree['"]/g },
  { command: 'checkout', pattern: /['"]checkout['"]/g },
  { command: 'branch', pattern: /['"]branch['"]/g },
]
const marker =
  /^\s*\/\/ branch-ref-guard: (?:assertBranchRefMayBeCreated|assertBranchRefMayBeDeleted|observeBranchRefMutation|non-local refs\/(?:orch|remotes)\/)\s*$/
const violations: string[] = []

function enclosingOpen(source: string, index: number, open: '(' | '[', close: ')' | ']'): number {
  let depth = 0
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (source[cursor] === close) depth++
    else if (source[cursor] === open) {
      if (depth === 0) return cursor
      depth--
    }
  }
  return -1
}

function enclosingArray(source: string, index: number): string | null {
  const start = enclosingOpen(source, index, '[', ']')
  if (start === -1) return null
  let depth = 0
  for (let cursor = start; cursor < source.length; cursor++) {
    if (source[cursor] === '[') depth++
    else if (source[cursor] === ']') {
      depth--
      if (depth === 0) return source.slice(start, cursor + 1)
    }
  }
  return null
}

function isMutationCommand(source: string, index: number, command: string): boolean {
  if (command === 'update-ref') return true
  const argv = enclosingArray(source, index)
  if (!argv) return false
  if (command === 'worktree') return /['"]add['"]/.test(argv) && /['"]-(?:b|B)['"]/.test(argv)
  if (command === 'checkout') return /['"]-B['"]/.test(argv)
  return /['"]-(?:d|D|m|M)['"]/.test(argv)
}

function enclosingCallStart(source: string, index: number): number {
  const enclosingCall = enclosingOpen(source, index, '(', ')')
  const enclosingArray = enclosingOpen(source, index, '[', ']')
  const callCrossesBlock = enclosingCall !== -1 && source.slice(enclosingCall, index).includes('{')
  const start = enclosingCall !== -1 && !callCrossesBlock ? enclosingCall : enclosingArray
  if (start !== -1) return source.lastIndexOf('\n', start - 1) + 1
  return source.lastIndexOf('\n', index - 1) + 1
}

function precedingLine(source: string, index: number): string {
  const before = source.slice(0, index)
  const lines = before.split('\n')
  return lines.at(-2) ?? ''
}

function isNonMutationUpdateRef(source: string, index: number): boolean {
  const lineEnd = source.indexOf('\n', index)
  const line = source.slice(index, lineEnd === -1 ? source.length : lineEnd)
  return /update-ref exited|update-ref failed/.test(line)
}

for (const path of files) {
  if (path.endsWith(join('branch', 'branch-ref-guard.ts'))) continue
  const source = readFileSync(path, 'utf8')
  for (const { command, pattern } of mutationPatterns) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0
      if (!isMutationCommand(source, index, command)) continue
      if (command === 'update-ref' && isNonMutationUpdateRef(source, index)) continue
      const callStart = enclosingCallStart(source, index)
      if (marker.test(precedingLine(source, callStart))) continue
      const line = source.slice(0, callStart).split('\n').length
      violations.push(`${relative(root, path)}:${line}`)
    }
  }
}

if (violations.length) {
  for (const violation of [...new Set(violations)]) {
    console.error(
      `${violation}: ref mutation needs a branch-ref-guard marker directly above it naming its guard or non-local namespace`,
    )
  }
  process.exit(1)
}

console.log(`branch ref mutation scan: ${(performance.now() - started).toFixed(1)}ms`)
