// concern: Goose registration compaction probe
/** Proves whether a Goose model accepts the harness's automatic compaction request. */

export const GOOSE_COMPACTION_PROBE_CONTEXT_LIMIT = 8_192
const COMPACTION_PROBE_SENTINEL = 'GOOSE_COMPACTION_PROBE_OK'
const SECOND_TURN_FILLER = `${'x '.repeat(6_700)}\n`

export type CompactionProbeResult = { ok: boolean; output: string }

type CompactionProbeTurn = (input: {
  prompt: string
  session?: string
  environment: Record<string, string>
}) => Promise<{
  status: 'ok' | 'failed' | 'asking'
  output: string
  sessionId: string | null
}>

/**
 * Start a short session below the threshold, then make its second model call
 * cross Goose's eighty-percent auto-compaction threshold. The repeated
 * one-token words keep the current prompt below the configured window after
 * the prior turn has been compacted.
 */
export async function probeAgentCompacts(
  runTurn: CompactionProbeTurn,
): Promise<CompactionProbeResult> {
  const environment = {
    GOOSE_CONTEXT_LIMIT: String(GOOSE_COMPACTION_PROBE_CONTEXT_LIMIT),
    GOOSE_AUTO_COMPACT_THRESHOLD: '0.8',
    GOOSE_TOOL_PAIR_SUMMARIZATION: 'false',
  }
  const first = await runTurn({
    prompt: 'Reply with exactly: ready',
    environment,
  })
  if (first.status !== 'ok' || !first.sessionId) {
    return { ok: false, output: first.output || 'Goose first compaction probe turn failed' }
  }
  const compacted = await runTurn({
    session: first.sessionId,
    prompt: `${SECOND_TURN_FILLER}Reply with exactly: ${COMPACTION_PROBE_SENTINEL}`,
    environment,
  })
  return {
    ok:
      compacted.status === 'ok' &&
      compacted.sessionId === first.sessionId &&
      compacted.output.includes(COMPACTION_PROBE_SENTINEL),
    output: compacted.output,
  }
}
