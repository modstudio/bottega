export const COMMENT_PARSER_LANGUAGES = ['bash', 'php', 'python'] as const

export type CommentParserLanguage = (typeof COMMENT_PARSER_LANGUAGES)[number]

export type CommentParserAsset = {
  language: CommentParserLanguage
  packagePath: string
  destination: string
  mode: 0o644
}

const PACKAGE_ROOT = 'orchestrator/node_modules/@ast-grep'

/** Give the operator the install-specific action that restores a missing parser. */
export function commentParserRemedy(
  installKind: 'checkout' | 'distribution' | null,
  platform: string,
  arch: string,
  languages: readonly string[],
): string {
  const named = languages.join(', ')
  const checkout = 'run bun install in the checkout and retry'
  const distribution = `the installed release does not carry the ${named} parser for ${platform}/${arch}; update to a release that does`
  if (installKind === 'checkout') return checkout
  if (installKind === 'distribution') return distribution
  return `if this is a checkout, ${checkout}; if this is a release install, ${distribution}`
}

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
