import type { ContextItemKind } from '../../src/doc/doc-context-write.ts'

/** Legacy document encoding used only to seed pre-DEV-2293 fixture inputs. */
export function encodeContextItem(input: {
  kind: ContextItemKind
  source: string
  objection?: string
  body: string
}): string {
  return [
    '---',
    `kind: ${JSON.stringify(input.kind)}`,
    `source: ${JSON.stringify(input.source)}`,
    ...(input.objection === undefined ? [] : [`objection: ${JSON.stringify(input.objection)}`]),
    '---',
    input.body,
  ].join('\n')
}

/** Decode the legacy document encoding used by pre-migration fixture callers. */
export function decodeContextItem(value: string): {
  kind: ContextItemKind
  source: string
  objection?: string
  body: string
} {
  const close = value.indexOf('\n---', 4)
  const frontmatter = value.slice(0, close)
  const field = (key: string): string | undefined => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter)
    return match?.[1] ? (JSON.parse(match[1]) as string) : undefined
  }
  const objection = field('objection')
  return {
    kind: field('kind') as ContextItemKind,
    source: field('source') ?? '',
    ...(objection === undefined ? {} : { objection }),
    body: value.slice(close + 5),
  }
}
