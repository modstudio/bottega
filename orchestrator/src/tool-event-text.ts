// concern: tool-event-text
/** Rendering and bounding for tool text retained in the run event ledger. */

export const TOOL_EVENT_TEXT_CHARS = 2_000
const TOOL_EVENT_CUT_MARKER = '… [truncated]'

export function capToolEventText(text: string): string {
  if (text.length <= TOOL_EVENT_TEXT_CHARS) return text
  return `${text.slice(0, TOOL_EVENT_TEXT_CHARS - TOOL_EVENT_CUT_MARKER.length)}${TOOL_EVENT_CUT_MARKER}`
}

export function renderToolInput(rawInput: unknown): string | undefined {
  if (rawInput === undefined) return undefined
  if (
    rawInput !== null &&
    typeof rawInput === 'object' &&
    !Array.isArray(rawInput) &&
    typeof (rawInput as Record<string, unknown>).command === 'string'
  ) {
    return capToolEventText((rawInput as Record<string, unknown>).command as string)
  }
  const rendered = JSON.stringify(rawInput)
  return rendered === undefined ? undefined : capToolEventText(rendered)
}
