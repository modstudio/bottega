import { readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import bash from '@ast-grep/lang-bash'
import php from '@ast-grep/lang-php'
import python from '@ast-grep/lang-python'
import { type DynamicLangRegistrations, Lang, parse, registerDynamicLanguage } from '@ast-grep/napi'
import {
  embeddedDistributionManifest,
  embeddedRuntimeDigest,
  extractEmbeddedRuntime,
  resolveInstallFile,
} from '../../../shared/embedded-assets.ts'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { installationIdentity } from '../../../shared/install-root.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'
import {
  COMMENT_PARSER_LANGUAGES,
  type CommentParserLanguage,
  commentParserAssets,
} from './check-comment-parser-assets.ts'
import {
  type CommentFinding,
  type CommentRules,
  type CommentSource,
  commentFindings,
} from './check-comments.ts'

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..')
const LANGUAGE_PACKAGES = { bash, php, python }

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

type SourceFile = { file: string; source: string }

type ExtractionPorts = {
  registerLanguages?: typeof registerDynamicLanguage
  installKind?: () => 'checkout' | 'distribution'
  environment?: StateEnvironment
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  resolveFile?: (relativePath: string, diskPath: string) => string | undefined
  readFile?: (path: string) => Buffer
}

let registeredLanguageKey: string | null = null

class CommentParserRefusal extends Error {}

function languageFor(file: string): Lang | CommentParserLanguage | null {
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

function dynamicLanguages(sources: SourceFile[]): CommentParserLanguage[] {
  const needed = new Set<CommentParserLanguage>()
  for (const { file } of sources) {
    const language = languageFor(file)
    if (language !== null && COMMENT_PARSER_LANGUAGES.includes(language as CommentParserLanguage)) {
      needed.add(language as CommentParserLanguage)
    }
  }
  return [...needed].sort()
}

function registrationWithPath(
  language: CommentParserLanguage,
  libraryPath: string,
): DynamicLangRegistrations[string] {
  const source = LANGUAGE_PACKAGES[language]
  return {
    libraryPath,
    extensions: source.extensions,
    languageSymbol: source.languageSymbol,
    expandoChar: source.expandoChar,
  }
}

function parserRefusal(
  languages: CommentParserLanguage[],
  detail: string,
  ports: ExtractionPorts,
): Error {
  const platform = ports.platform ?? process.platform
  const arch = ports.arch ?? process.arch
  const installKind =
    ports.installKind?.() ?? installationIdentity(import.meta.dir, process.env).kind
  const named = languages.join(', ')
  const remedy =
    installKind === 'checkout'
      ? 'run bun install in the checkout and retry'
      : `the installed release does not carry the ${named} parser for ${platform}/${arch}; update to a release that does`
  return new CommentParserRefusal(
    `could not load the ${named} comment parser for ${platform}/${arch} from the ${installKind} install: ${detail}; ${remedy}`,
  )
}

function checkoutRegistrations(
  languages: CommentParserLanguage[],
  ports: ExtractionPorts,
): DynamicLangRegistrations {
  const registrations: DynamicLangRegistrations = {}
  for (const language of languages) {
    try {
      registrations[language] = registrationWithPath(
        language,
        LANGUAGE_PACKAGES[language].libraryPath,
      )
    } catch (error) {
      throw parserRefusal([language], error instanceof Error ? error.message : String(error), ports)
    }
  }
  return registrations
}

function embeddedRegistrations(
  languages: CommentParserLanguage[],
  ports: ExtractionPorts,
): DynamicLangRegistrations {
  const manifest = embeddedDistributionManifest()
  if (!manifest) return checkoutRegistrations(languages, ports)
  const platform = ports.platform ?? process.platform
  const arch = ports.arch ?? process.arch
  const assets = commentParserAssets(`${platform}-${arch}`).filter(({ language }) =>
    languages.includes(language),
  )
  const expected = assets.map((asset) => {
    const source = (ports.resolveFile ?? resolveInstallFile)(
      asset.packagePath,
      join(REPOSITORY_ROOT, asset.packagePath),
    )
    try {
      if (!source)
        throw new Error(`compiled comment parser payload is missing: ${asset.packagePath}`)
      const bytes = (ports.readFile ?? readFileSync)(source)
      return { ...asset, bytes, digest: embeddedRuntimeDigest(bytes) }
    } catch (error) {
      throw parserRefusal(
        [asset.language],
        error instanceof Error ? error.message : String(error),
        ports,
      )
    }
  })
  const root = join(
    resolveStateRoot(ports.environment ?? process.env),
    'runtime',
    manifest.version,
    'comment-parsers',
  )
  extractEmbeddedRuntime(root, expected, 'compiled comment parsers')
  return Object.fromEntries(
    assets.map(({ language, destination }) => [
      language,
      registrationWithPath(language, join(root, destination)),
    ]),
  )
}

function ensureDynamicLanguages(languages: CommentParserLanguage[], ports: ExtractionPorts): void {
  if (languages.length === 0) return
  const register = ports.registerLanguages ?? registerDynamicLanguage
  const key = languages.join(',')
  if (register === registerDynamicLanguage && registeredLanguageKey === key) return
  if (register === registerDynamicLanguage && registeredLanguageKey !== null) {
    throw parserRefusal(
      languages,
      `ast-grep already registered ${registeredLanguageKey} in this process`,
      ports,
    )
  }
  try {
    register(embeddedRegistrations(languages, ports))
    if (register === registerDynamicLanguage) registeredLanguageKey = key
  } catch (error) {
    if (error instanceof CommentParserRefusal) throw error
    throw parserRefusal(languages, error instanceof Error ? error.message : String(error), ports)
  }
}

function commentsInSources(sources: SourceFile[], ports: ExtractionPorts = {}): CommentSource[] {
  ensureDynamicLanguages(dynamicLanguages(sources), ports)
  return sources.flatMap(({ file, source }) => {
    const language = languageFor(file)
    if (!language) return []
    return parse(language, source)
      .root()
      .findAll({ rule: { kind: 'comment' } })
      .map((node) => ({ file, line: node.range().start.line + 1, text: node.text() }))
  })
}

/** The ast-grep adapter converts a source file into plain comment facts. */
export function commentsInSource(file: string, source: string): CommentSource[] {
  return commentsInSources([{ file, source }])
}

/** In-process seam for checking source fixtures without a Git or CLI subprocess. */
export function commentFindingsInSources(
  sources: SourceFile[],
  rules: CommentRules,
  ports: ExtractionPorts = {},
): CommentFinding[] {
  return commentsInSources(sources, ports).flatMap((comment) => commentFindings(comment, rules))
}

function trackedSources(root: string): SourceFile[] {
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
    .flatMap((file) => {
      try {
        return [{ file, source: readFileSync(resolve(root, file), 'utf8') }]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`could not read tracked source file ${file}: ${detail}`)
      }
    })
}

export function trackedCommentFindings(root: string, rules: CommentRules): CommentFinding[] {
  return commentFindingsInSources(trackedSources(root), rules)
}
