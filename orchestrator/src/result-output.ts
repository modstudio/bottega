/** Maximum recovered transcript text printed by `orch result` for a truncated run. */
export const TRUNCATED_TRANSCRIPT_BYTES = 32 * 1024

/** Extract human-readable prose from a persisted vendor transcript. */
export function visibleTranscriptText(agent: string, transcript: string): string {
  if (agent !== 'grok') return transcript
  const parts: string[] = []
  for (const line of transcript.split('\n')) {
    const s = line.trimStart()
    if (!s.startsWith('{')) continue
    try {
      const event = JSON.parse(s)
      if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue
      for (const block of event.message.content) {
        if (typeof block?.text === 'string' && block.text) parts.push(block.text)
      }
    } catch { /* A half-written terminal line has no recoverable visible text. */ }
  }
  return parts.join('\n\n')
}
