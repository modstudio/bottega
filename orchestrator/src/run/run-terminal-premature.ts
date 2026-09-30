// concern: run-terminal-premature
/**
 * Adapts parsed terminal replies and measured execution facts to the pure
 * premature-final policy. It must not persist or route an outcome.
 */
import { parseReaderOutput, type ReviewReply, type WorkerReply } from '../contract/contract.ts'
import {
  decidePrematureFinal,
  type PrematureFinalRefusal,
  type PrematureFinalReplyShape,
} from '../evidence/premature-final.ts'
import type { OutcomeStatus } from '../outcome.ts'

export function terminalPrematureFinalRefusal(input: {
  readerJob: boolean
  output: string
  parsedReview: ReviewReply | null
  contract: WorkerReply | null
  measuredFiles: readonly string[] | null
  workerEvents: ReadonlyArray<{ kind: string }>
  acceptedQuestionCount: number
  exitCode: number
  latencyMs: number
}): PrematureFinalRefusal | null {
  const readerReply = input.readerJob ? parseReaderOutput(input.output) : null
  let replyShape: PrematureFinalReplyShape = 'other'
  if (
    readerReply?.deliverables.length &&
    readerReply.deliverables.every((item) => item.status === 'blocked')
  ) {
    replyShape = 'all-blocked-reader'
  } else if (input.parsedReview && input.parsedReview.findings.length === 0) {
    replyShape = 'empty-review'
  } else if (
    input.contract?.status === 'done' &&
    Array.isArray(input.measuredFiles) &&
    input.measuredFiles.length === 0
  ) {
    replyShape = 'done-writer-no-files'
  }

  return decidePrematureFinal({
    exitCode: input.exitCode,
    latencyMs: input.latencyMs,
    toolEventRecorded: input.workerEvents.some((event) => event.kind === 'tool'),
    evidence: {
      filesWritten: readerReply?.files_written,
      filesChanged: input.contract?.files_changed,
      findings: input.parsedReview?.findings,
      filesCovered: input.parsedReview?.provenance.files_covered,
      commandsRun:
        input.parsedReview?.provenance.commands_run ??
        (input.contract?.tests?.ran && input.contract.tests.command
          ? [input.contract.tests.command]
          : undefined),
      mcpTools: input.parsedReview?.provenance.mcp_tools,
      docsRead: input.parsedReview?.provenance.docs_read,
    },
    questionsAsked: input.acceptedQuestionCount > 0,
    replyShape,
    textFields: [
      ...(readerReply?.deliverables.map((item) => item.content) ?? []),
      ...(readerReply?.narrative ? [readerReply.narrative] : []),
      ...(input.parsedReview?.provenance.could_not_verify ?? []),
      ...(input.contract?.summary ? [input.contract.summary] : []),
    ],
  })
}

/** Apply the refusal without adding another branch to terminal orchestration. */
export function applyPrematureFinalFailure<FailureKind extends string>(
  outcome: { status: OutcomeStatus; error: string | null; failureKind: FailureKind | null },
  refusal: PrematureFinalRefusal | null,
): {
  status: OutcomeStatus
  error: string | null
  failureKind: FailureKind | 'unevidenced' | null
} {
  if (!refusal) return outcome
  if (outcome.status === 'ok') return { status: 'failed', ...refusal }
  if (outcome.failureKind === 'unevidenced') return { ...outcome, error: refusal.error }
  return outcome
}
