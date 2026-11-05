/** Pure reader for the canon frontmatter fields shared across concerns. */

function frontmatterBoolean(value: string | undefined): boolean | null {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

export function canonFrontmatter(text: string): {
  description: string | null
  paths: string[]
  declaresPaths: boolean
  always: boolean | null
  declaresAlways: boolean
  enforce: boolean | null
  declaresEnforce: boolean
} | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const yaml = match[1]!
  const description = yaml.match(/^description:\s*(.*?)\s*$/m)?.[1] ?? null
  const cleanDescription = description?.replace(/^(['"])(.*)\1$/, '$2').trim()
  const validDescription =
    cleanDescription && !['null', '~', '[]', '{}'].includes(cleanDescription)
      ? cleanDescription
      : null
  const alwaysValue = yaml.match(/^always:\s*(.*?)\s*$/m)?.[1]
  const declaresAlways = alwaysValue !== undefined
  const always = frontmatterBoolean(alwaysValue)
  const enforceValue = yaml.match(/^enforce:\s*(.*?)\s*$/m)?.[1]
  const declaresEnforce = enforceValue !== undefined
  const enforce = frontmatterBoolean(enforceValue)
  const inlinePaths = yaml.match(/^paths:\s*\[(.*?)\]\s*$/m)?.[1]
  if (inlinePaths !== undefined) {
    return {
      description: validDescription,
      declaresPaths: true,
      always,
      declaresAlways,
      enforce,
      declaresEnforce,
      paths: inlinePaths
        .split(',')
        .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean),
    }
  }
  const lines = yaml.split(/\r?\n/)
  const pathsAt = lines.findIndex((line) => /^paths:\s*$/.test(line))
  const paths: string[] = []
  if (pathsAt >= 0) {
    for (const line of lines.slice(pathsAt + 1)) {
      const item = line.match(/^\s+-\s+(.+?)\s*$/)?.[1]
      if (!item) break
      paths.push(item.replace(/^['"]|['"]$/g, ''))
    }
  }
  return {
    description: validDescription,
    paths,
    declaresPaths: pathsAt >= 0,
    always,
    declaresAlways,
    enforce,
    declaresEnforce,
  }
}
