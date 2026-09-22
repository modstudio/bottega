// concern: run-reply-source
/**
 * Knows which collected reply source becomes the public output. Must not know
 * files, stores, processes, or run terminalisation.
 */
import { REPLY_FILE_NAME } from '../contract/contract.ts'
import { schemaMismatchError } from '../transport/transport.ts'

export type ReplyContract = 'none' | 'text' | 'custom'

export type ReplySourceFacts = {
  replyFile: { present: false } | { present: true; text: string; matches: boolean }
  contract: ReplyContract
  fallback: { text: string; matches: boolean }
}

export type ReplySourceRuling = {
  output: string
  replyFileError: string | null
  replyFilePresent: boolean
  rewriteOutputFile: boolean
}

function unwrapTextReply(text: string): string {
  return (JSON.parse(text) as { answer: string }).answer
}

/** Decide whether the reply file or transport fallback supplies the public result. */
export function decideReplySource(facts: ReplySourceFacts): ReplySourceRuling {
  if (facts.replyFile.present) {
    const output =
      facts.replyFile.matches && facts.contract === 'text'
        ? unwrapTextReply(facts.replyFile.text)
        : facts.replyFile.text
    return {
      output,
      replyFileError: facts.replyFile.matches
        ? null
        : `${REPLY_FILE_NAME} did not match the worker contract:\n${facts.replyFile.text}`,
      replyFilePresent: true,
      rewriteOutputFile: true,
    }
  }

  const output =
    facts.contract === 'text' && facts.fallback.matches
      ? unwrapTextReply(facts.fallback.text)
      : facts.fallback.text
  return {
    output,
    replyFileError:
      facts.contract === 'custom' && !facts.fallback.matches
        ? schemaMismatchError(facts.fallback.text)
        : null,
    replyFilePresent: false,
    rewriteOutputFile: facts.contract === 'text',
  }
}
