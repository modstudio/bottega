import type { FocusedTestExecutionObservation } from '../run/run-test-outcome.ts'

/** Maximum recovered transcript text printed by `bottega run result` for a truncated run. */
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
    } catch {
      /* A half-written terminal line has no recoverable visible text. */
    }
  }
  return parts.join('\n\n')
}

/** Present Bottega's observation independently, leaving the stored worker reply untouched. */
export function observedTestsLine(input: {
  ran: number | null
  passed: number | null
  claimDisagrees: number | null
}): string | null {
  if (input.ran === null) {
    return input.claimDisagrees === null
      ? null
      : 'tests observed: not observed; tests_claim_disagrees: false'
  }
  const disagreement =
    input.claimDisagrees === null ? 'unverified' : String(Boolean(input.claimDisagrees))
  return (
    `tests observed: {"ran":${Boolean(input.ran)},"passed":` +
    `${input.passed === null ? 'null' : Boolean(input.passed)}}; ` +
    `tests_claim_disagrees: ${disagreement}`
  )
}

/** Render every declared mutation-probe execution that observed a result. */
export function declaredExpectFailProbeLines(
  observations: readonly FocusedTestExecutionObservation[],
): string[] {
  return observations
    .filter((observation) => observation.expect === 'fail')
    .map(
      (observation) =>
        `declared expect-fail probe: ${observation.paths.join(', ')} → ${observation.passed ? 'passed' : 'failed'}`,
    )
}
