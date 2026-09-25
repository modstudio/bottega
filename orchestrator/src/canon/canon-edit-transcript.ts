// concern: canon-edit-transcript
/** Knows transcript role, ordering, pairing, and compaction windows for the canon guard. */

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export type TranscriptEvent =
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: boolean; error: boolean }
export type TranscriptWatermark = number | 'unknown'

function record(value: unknown): { role: unknown; content: Record<string, unknown>[] } | null {
  if (!value || typeof value !== 'object') return null
  const message = (value as { message?: unknown }).message
  if (!message || typeof message !== 'object') return null
  const fields = message as { role?: unknown; content?: unknown }
  if (!Array.isArray(fields.content)) return null
  return { role: fields.role, content: fields.content as Record<string, unknown>[] }
}

function carriedContent(block: Record<string, unknown>): boolean {
  if (block.is_error === true) return false
  const substance = (text: string) => text.replace(REMINDER, '').trim() !== ''
  if (typeof block.content === 'string') return substance(block.content)
  if (!Array.isArray(block.content)) return false
  return block.content.some((part) => {
    if (!part || typeof part !== 'object') return false
    const item = part as Record<string, unknown>
    return typeof item.text === 'string' ? substance(item.text) : item.type !== 'text'
  })
}

/** Parse ordered, correctly-role-attributed transcript events after a line-count watermark. */
export function parseTranscriptEvents(lines: string[], watermark: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  const seenUses = new Set<string>()
  const paired = new Set<string>()
  for (const line of lines.slice(Math.max(0, watermark))) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const item = record(entry)
    if (!item) continue
    for (const block of item.content) {
      if (
        item.role === 'assistant' &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        !seenUses.has(block.id)
      ) {
        seenUses.add(block.id)
        events.push({ kind: 'tool_use', id: block.id, name: block.name, input: block.input })
      } else if (
        item.role === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        seenUses.has(block.tool_use_id) &&
        !paired.has(block.tool_use_id)
      ) {
        paired.add(block.tool_use_id)
        events.push({
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          content: carriedContent(block),
          error: block.is_error === true,
        })
      }
    }
  }
  return events
}

/** Resolve `unknown` by anchoring at the transcript's current line count. */
export function transcriptAfterWatermark(
  lines: string[],
  watermark: TranscriptWatermark,
): { events: TranscriptEvent[]; anchoredAt: number | null } {
  if (watermark === 'unknown') return { events: [], anchoredAt: lines.length }
  const effective = watermark > lines.length ? 0 : watermark
  return { events: parseTranscriptEvents(lines, effective), anchoredAt: null }
}
