export const COMMENT_PARSER_LANGUAGES = ['bash', 'php', 'python'] as const

export type CommentParserLanguage = (typeof COMMENT_PARSER_LANGUAGES)[number]

export type CommentParserAsset = {
  language: CommentParserLanguage
  packagePath: string
  destination: string
  mode: 0o644
}

const PACKAGE_ROOT = 'orchestrator/node_modules/@ast-grep'

/** Map one compiled-binary target to exactly the dynamic comment parsers it carries. */
export function commentParserAssets(target: string): CommentParserAsset[] {
  const [platform, arch, extra] = target.split('-')
  const packagePlatform = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : null
  const packageArch = arch === 'arm64' ? 'ARM64' : arch === 'x64' ? 'X64' : null
  if (!packagePlatform || !packageArch || extra) {
    throw new Error(`unsupported comment parser target ${JSON.stringify(target)}`)
  }
  return COMMENT_PARSER_LANGUAGES.map((language) => ({
    language,
    packagePath: `${PACKAGE_ROOT}/lang-${language}/prebuilds/prebuild-${packagePlatform}-${packageArch}/parser.so`,
    destination: `${language}/parser.so`,
    mode: 0o644,
  }))
}
