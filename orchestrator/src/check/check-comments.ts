import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import bash from '@ast-grep/lang-bash'
import php from '@ast-grep/lang-php'
import python from '@ast-grep/lang-python'
import { Lang, parse, registerDynamicLanguage } from '@ast-grep/napi'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { DEFAULT_COMMENT_HISTORY_PHRASES } from '../canon/prose-lint.ts'

registerDynamicLanguage({ bash, php, python })

export type CommentSource = {
  file: string
  line: number
  text: string
}

export type CommentRules = {
  taskKeyPrefixes?: readonly string[]
  historyPhrases?: readonly string[]
}

export type CommentFinding = {
  file: string
  line: number
  rule: 'task-key' | 'history' | 'history-allow'
  match: string
  comment: string
}

export { DEFAULT_COMMENT_HISTORY_PHRASES }

const SOURCE_GLOBS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.php',
  '*.sh',
  '*.bash',
  '*.zsh',
  '*.bats',
  '*.py',
]

function languageFor(file: string): Lang | string | null {
  switch (extname(file).toLowerCase()) {
    case '.ts':
      return Lang.TypeScript
    case '.tsx':
    case '.jsx':
      return Lang.Tsx
    case '.js':
    case '.mjs':
    case '.cjs':
      return Lang.JavaScript
    case '.php':
      return 'php'
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.bats':
      return 'bash'
    case '.py':
      return 'python'
    default:
      return null
  }
}

/** The ast-grep adapter converts a source file into plain comment facts. */
export function commentsInSource(file: string, source: string): CommentSource[] {
  const language = languageFor(file)
  if (!language) return []
  return parse(language, source)
    .root()
    .findAll({ rule: { kind: 'comment' } })
    .map((node) => ({ file, line: node.range().start.line + 1, text: node.text() }))
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchLine(startLine: number, text: string, index: number): number {
  return startLine + text.slice(0, index).split('\n').length - 1
}

function historyMarker(comment: string): 'absent' | 'empty' | 'allowed' {
  let found = false
  for (const match of comment.matchAll(/history-ok:\s*([^\r\n]*)/gi)) {
    found = true
    const reason = match[1]!.replace(/\*\/\s*$/, '').trim()
    if (reason) return 'allowed'
  }
  return found ? 'empty' : 'absent'
}

/** Findings are a pure decision over one extracted comment and supplied rules. */
export function commentFindings(comment: CommentSource, rules: CommentRules): CommentFinding[] {
  const findings: CommentFinding[] = []
  const prefixes = rules.taskKeyPrefixes?.filter(Boolean) ?? []
  if (prefixes.length) {
    const taskKey = new RegExp(
      `(?<![A-Za-z0-9])(?:${prefixes.map(escaped).join('|')})-\\d+\\b`,
      'g',
    )
    for (const match of comment.text.matchAll(taskKey)) {
      findings.push({
        file: comment.file,
        line: matchLine(comment.line, comment.text, match.index),
        rule: 'task-key',
        match: match[0],
        comment: comment.text,
      })
    }
  }

  const phrases = rules.historyPhrases ?? []
  if (!phrases.length) return findings
  const marker = historyMarker(comment.text)
  if (marker === 'allowed') return findings
  if (marker === 'empty') {
    const index = comment.text.search(/history-ok:/i)
    findings.push({
      file: comment.file,
      line: matchLine(comment.line, comment.text, index),
      rule: 'history-allow',
      match: 'history-ok:',
      comment: comment.text,
    })
    return findings
  }

  for (const phrase of phrases.filter(Boolean)) {
    const phrasePattern = phrase.trim().split(/\s+/).map(escaped).join('\\s+')
    const pattern = new RegExp(`\\b${phrasePattern}\\b`, 'gi')
    for (const match of comment.text.matchAll(pattern)) {
      findings.push({
        file: comment.file,
        line: matchLine(comment.line, comment.text, match.index),
        rule: 'history',
        match: match[0],
        comment: comment.text,
      })
    }
  }
  return findings
}

function trackedComments(root: string): CommentSource[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '--', ...SOURCE_GLOBS], {
    cwd: root,
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not list tracked source files: ${result.stderr.toString().trim()}`)
  }
  return result.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .flatMap((file) => commentsInSource(file, readFileSync(resolve(root, file), 'utf8')))
}

export function trackedCommentFindings(root: string, rules: CommentRules): CommentFinding[] {
  return trackedComments(root).flatMap((comment) => commentFindings(comment, rules))
}

export function formatCommentFinding(finding: CommentFinding): string {
  const match = finding.match.replace(/\s+/g, ' ')
  if (finding.rule === 'task-key') {
    return `${finding.file}:${finding.line}: task key in comment: ${match}`
  }
  if (finding.rule === 'history-allow') {
    return `${finding.file}:${finding.line}: history-ok: requires a non-empty reason`
  }
  return `${finding.file}:${finding.line}: history phrase in comment: ${match}`
}
