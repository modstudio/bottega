// concern: run-terminal-premature
/**
 * Adapts parsed terminal replies and measured execution facts to the pure
 * premature-final policy. It must not persist or route an outcome.
 */
import type { ReaderReply, ReviewReply, WorkerReply } from '../contract/contract.ts'
import {
  applyPrematureFinalFailure as applyPrematureFinalPolicy,
  decidePrematureFinal,
  type PrematureFinalRefusal,
  type PrematureFinalReplyShape,
} from '../evidence/premature-final.ts'
import type { OutcomeStatus } from '../outcome.ts'

export function terminalPrematureFinalRefusal(input: {
  readerReply: ReaderReply | null
  parsedReview: ReviewReply | null
  contract: WorkerReply | null
  measuredFiles: readonly string[] | null
  workerEvents: ReadonlyArray<{ kind: string }>
  acceptedQuestionCount: number
  exitCode: number
}): PrematureFinalRefusal | null {
  const readerReply = input.readerReply
  let replyShape: PrematureFinalReplyShape = 'other'
  if (readerReply) {
    replyShape = 'reader'
  } else if (input.parsedReview) {
    replyShape = 'review'
  } else if (input.contract) {
    replyShape = 'done-writer'
  }

  return decidePrematureFinal({
    exitCode: input.exitCode,
    toolEventRecorded: input.workerEvents.some((event) => event.kind === 'tool'),
    evidence: {
      filesWritten: readerReply?.files_written,
      filesChanged: input.contract?.files_changed,
      filesCovered: input.parsedReview?.provenance.files_covered,
      commandsRun:
        input.parsedReview?.provenance.commands_run ??
        (input.contract?.tests?.ran && input.contract.tests.command
          ? [input.contract.tests.command]
          : undefined),
      mcpTools: input.parsedReview?.provenance.mcp_tools,
      docsRead: input.parsedReview?.provenance.docs_read,
    },
    reportsRun: Boolean(input.contract?.tests?.ran),
    questionsAsked: input.acceptedQuestionCount > 0,
    replyShape,
    readerDelivered: Boolean(readerReply?.deliverables.some((item) => item.status === 'delivered')),
    measuredFiles: input.measuredFiles,
    textFields: [
      ...(readerReply?.deliverables.map((item) => item.content) ?? []),
      ...(readerReply?.narrative ? [readerReply.narrative] : []),
      ...(input.parsedReview?.findings.map((finding) => finding.evidence) ?? []),
      ...(input.parsedReview?.provenance.could_not_verify ?? []),
      ...(input.contract?.summary ? [input.contract.summary] : []),
      ...(input.contract?.tests?.detail ? [input.contract.tests.detail] : []),
      ...(input.contract?.deviations?.flatMap((item) => [item.what, item.why]) ?? []),
      ...(input.contract?.blockers?.flatMap((item) => [item.what, item.why, item.impact]) ?? []),
    ],
  })
}

/** Apply the pure precedence policy to the terminal adapter's provisional outcome. */
export function applyPrematureFinalFailure<FailureKind extends string>(
  outcome: { status: OutcomeStatus; error: string | null; failureKind: FailureKind | null },
  refusal: PrematureFinalRefusal | null,
) {
  return applyPrematureFinalPolicy(outcome, refusal)
}
