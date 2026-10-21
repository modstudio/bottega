import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import bash from '@ast-grep/lang-bash'
import php from '@ast-grep/lang-php'
import python from '@ast-grep/lang-python'
import { Lang, parse, registerDynamicLanguage } from '@ast-grep/napi'
import { inspectionGitEnv } from '../../../shared/git.ts'
import {
  type CommentFinding,
  type CommentRules,
  type CommentSource,
  commentFindings,
} from './check-comments.ts'

registerDynamicLanguage({ bash, php, python })

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
