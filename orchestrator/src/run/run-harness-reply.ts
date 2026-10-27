// concern: harness reply collection
/** Purely classifies the reply artifact for a processless harness run. */

import type { ReplyDialect } from '../contract/contract.ts'
import { REPLY_FILE_NAME, realQuestions } from '../contract/contract.ts'
import { deriveLiveOutcome } from '../live-outcome.ts'
import { decideOutcome, schemaEnvelopeContractError } from '../outcome.ts'
import { collectReplySource, type ReplyContract } from './run-reply-source.ts'

export function decideHarnessReply(
  replyText: string | null,
  dialect: ReplyDialect,
  writesJob: boolean,
  contract: ReplyContract = 'none',
  schema: unknown = null,
) {
  const source = collectReplySource({
    replyFileText: replyText,
    fallbackText: '',
    contract,
    dialect,
    schema,
  })
  const parsed = dialect.parse(source.output)
  const reply = parsed.reply
  const statusReply =
    reply && typeof reply === 'object' && 'status' in reply ? (reply as { status: string }) : null
  const missingError = replyText === null ? `${REPLY_FILE_NAME} is missing` : null
  const acceptedQuestions = statusReply ? realQuestions(reply as never) : []
  const replyFileError = schemaEnvelopeContractError(
    source.replyFileError,
    source.replyFileValue,
    schema ?? dialect.schema,
  )
  const derived = deriveLiveOutcome({
    writesJob,
    contractStatus: (statusReply?.status as 'done' | 'asking' | 'refused' | undefined) ?? null,
    replyError: missingError,
    output: source.output,
    replyFilePresent: source.replyFilePresent,
    replyFileError,
    transportName: 'harness',
    transportStatus: 'completed',
    transportStopReason: null,
    transportError: null,
    transportFailureKind: null,
    collectedAsking: false,
    acceptedQuestions: acceptedQuestions.length > 0,
    idleKilled: false,
    idleKillError: null,
    outputCeilingReached: false,
    outputCeilingStopReason: null,
    timedOut: false,
    stderr: '',
    stdout: '',
    exitCode: replyText === null ? 1 : 0,
    signal: null,
    sandbox: 'host',
    boundMs: 0,
    agentName: 'harness',
  })
  const outcome = decideOutcome(derived.inputs)
  return {
    output: source.output,
    reply,
    contractObjects: parsed.contractObjects,
    status: outcome.status,
    error: derived.error,
    failureKind: outcome.failureKind,
  }
}
