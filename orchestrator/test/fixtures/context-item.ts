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
