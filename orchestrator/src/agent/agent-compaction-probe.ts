// concern: Goose registration compaction probe
/** Proves whether a Goose model accepts the harness's automatic compaction request. */

const GOOSE_COMPACTION_PROBE_CONTEXT_LIMIT = 16_384
const COMPACTION_PROBE_SENTINEL = 'GOOSE_COMPACTION_PROBE_OK'
const SECOND_TURN_FILLER = `${'x '.repeat(8_000)}\n`
const COMPACTION_ERROR_MARKER = 'Ran into this error trying to compact'

type CompactionProbeResult = { ok: boolean | null; output: string }

type CompactionProbeTurn = (input: {
  prompt: string
  session?: string
  environment: Record<string, string>
}) => Promise<{
  status: 'ok' | 'failed' | 'asking'
  output: string
  sessionId: string | null
  compactions: number | null
}>

/**
 * Start a short session below the threshold, then make its second model call
 * cross Goose's eighty-percent auto-compaction threshold. ACP Goose run
 * 01a1bbaf-8c3f-7756-bfef-8f7130a911a1 measured fixed request overhead at
 * 7_000–8_600 tokens, so 16_384 leaves room for turn one and 8_000 one-token
 * words force turn two across the threshold.
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
  if (first.output.includes(COMPACTION_ERROR_MARKER)) {
    return { ok: false, output: first.output }
  }
  if (first.status !== 'ok' || !first.sessionId) {
    return {
      ok: null,
      output: `Compaction capability unestablished: first turn failed${
        first.output ? `: ${first.output}` : ''
      }`,
    }
  }
  const compacted = await runTurn({
    session: first.sessionId,
    prompt: `${SECOND_TURN_FILLER}Reply with exactly: ${COMPACTION_PROBE_SENTINEL}`,
    environment,
  })
  if (compacted.output.includes(COMPACTION_ERROR_MARKER)) {
    return { ok: false, output: compacted.output }
  }
  if (
    compacted.status === 'ok' &&
    compacted.sessionId === first.sessionId &&
    compacted.output.includes(COMPACTION_PROBE_SENTINEL)
  ) {
    return compacted.compactions !== null && compacted.compactions > 0
      ? { ok: true, output: compacted.output }
      : {
          ok: null,
          output: 'Compaction capability unestablished: no compaction observed',
        }
  }
  const reason =
    compacted.status !== 'ok'
      ? 'second turn failed outside compaction'
      : compacted.sessionId !== first.sessionId
        ? 'second turn did not continue the same session'
        : 'second turn did not return the sentinel'
  return {
    ok: null,
    output: `Compaction capability unestablished: ${reason}${
      compacted.output ? `: ${compacted.output}` : ''
    }`,
  }
}
