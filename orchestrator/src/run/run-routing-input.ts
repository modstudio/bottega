// concern: run routing input
/** Measures the full first-turn prompt shape used by the router. */

import { type CanonSource, replyFileBytes } from '../contract/contract.ts'
import { canonSourceInstruction } from '../mcp/mcp-preflight.ts'
import { CALIBRATION_SUFFIX_RESERVE_BYTES } from '../review/review-calibration.ts'
import { runScratchDir } from './run-artifacts.ts'

const CANON_SOURCE_PROMPT_RESERVE_BYTES =
  Math.max(
    ...(['live database', 'mirror', 'unknown'] as CanonSource[]).map((source) =>
      Buffer.byteLength(canonSourceInstruction(source)),
    ),
  ) + 2

const PROMPT_SIZE_RUN_RECORD_ID = '00000000-0000-7000-8000-000000000000'

/**
 * The reader-instruction prefix a routed prompt carries on its first turn.
 *
 * Both routing call sites compose the prompt they measure through this, so the
 * prefix is counted once for the dispatch pre-pick and once for the run's pick.
 * The two call sites still measure different prompts — the pre-pick holds the
 * raw caller text while the run's pick holds the composed pack — so this
 * function fixes only the prefix, not which string each site measures.
 */
export function routedPromptText(
  prompt: string,
  readerInstruction: string | null,
  firstTurn: boolean,
): string {
  return readerInstruction && firstTurn ? `${readerInstruction}\n\n${prompt}` : prompt
}

export function routedPromptBytes(
  prompt: string,
  replySchemaName: string,
  requestedJob: { findings?: unknown },
  requiresCanonSource: boolean,
): number {
  return (
    Buffer.byteLength(prompt) +
    replyFileBytes(replySchemaName, runScratchDir(PROMPT_SIZE_RUN_RECORD_ID)) +
    (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0) +
    (requiresCanonSource ? CANON_SOURCE_PROMPT_RESERVE_BYTES : 0)
  )
}
