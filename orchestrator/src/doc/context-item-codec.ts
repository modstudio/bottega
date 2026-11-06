// concern: context-item-codec
/** Encodes context item metadata in document frontmatter. */
import { CONTEXT_ITEM_KINDS, type ContextItem, type ContextItemKind } from './doc-context-write.ts'

function value(body: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body.slice(0, body.indexOf('\n---', 4)))
  const raw = match?.[1]?.trim()
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

export function decodeContextItem(holder: string, id: string, storedBody: string): ContextItem {
  if (!storedBody.startsWith('---\n'))
    throw new Error(`context item ${id} requires YAML frontmatter`)
  const end = storedBody.indexOf('\n---', 4)
  if (end < 0) throw new Error(`context item ${id} requires closed YAML frontmatter`)
  const kind = value(storedBody, 'kind')
  if (!CONTEXT_ITEM_KINDS.includes(kind as ContextItemKind)) {
    throw new Error(`context item ${id} has unknown kind ${JSON.stringify(kind ?? '')}`)
  }
  return {
    holder,
    id,
    kind: kind as ContextItemKind,
    source: value(storedBody, 'source') ?? '',
    objection: value(storedBody, 'objection'),
    body: storedBody.slice(end + 4).replace(/^\r?\n/, ''),
  }
}

const yamlValue = (input: string) => JSON.stringify(input)
export function encodeContextItem(input: {
  kind: ContextItemKind
  source: string
  objection?: string
  body: string
}): string {
  return [
    '---',
    `kind: ${yamlValue(input.kind)}`,
    `source: ${yamlValue(input.source)}`,
    ...(input.objection === undefined ? [] : [`objection: ${yamlValue(input.objection)}`]),
    '---',
    input.body,
  ].join('\n')
}
