/** Declarations that belong in markdown.css, not the rich editor chrome. */
const FORBIDDEN =
  /^(?:font(?:-.*)?|line-height|letter-spacing|margin(?:-.*)?|padding(?:-.*)?|color|text-.*|list-style(?:-.*)?)$/i

function declarationProperty(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return null
  }
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return null
  const property = trimmed.slice(0, colon).trim()
  if (!property || property.includes('{') || property.includes('}')) return null
  return property
}

/**
 * Findings for a rich-editor stylesheet that tried to set text styling.
 * The message names markdown.css as the home for those declarations.
 */
export function forbiddenRichEditorDeclarations(css: string): string[] {
  const findings: string[] = []
  for (const line of css.split('\n')) {
    const property = declarationProperty(line)
    if (!property || !FORBIDDEN.test(property)) continue
    findings.push(
      `${property}: text styling belongs in hub/views/src/styles/markdown.css, not the rich editor chrome`,
    )
  }
  return findings
}
