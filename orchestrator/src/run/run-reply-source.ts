// concern: run-reply-source
/**
 * Knows which collected reply source becomes the public output. Must not know
 * files, stores, processes, or run terminalisation.
 */
import { REPLY_FILE_NAME, type ReplyDialect, TEXT_REPLY_SCHEMA } from '../contract/contract.ts'
import { type JsonSchema, validatesSchema } from '../contract/contract-reply.ts'
import { schemaMismatchError, valueMatchesStrictSchema } from '../transport/transport.ts'

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

function matchesReplyFile(
  contract: ReplyContract,
  text: string,
  dialect: ReplyDialect,
  schema: unknown,
): boolean {
  if (contract !== 'custom') return dialect.parse(text).reply !== null
  try {
    return validatesSchema(JSON.parse(text), schema as JsonSchema)
  } catch {
    return false
  }
}

function matchesFallback(contract: ReplyContract, text: string, schema: unknown): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  if (contract === 'text') return valueMatchesStrictSchema(TEXT_REPLY_SCHEMA, value)
  if (contract === 'custom') return valueMatchesStrictSchema(schema, value)
  return false
}

/** Apply one reply-file and contract-validation decision for live and processless workers. */
export function collectReplySource(input: {
  replyFileText: string | null
  fallbackText: string
  contract: ReplyContract
  dialect: ReplyDialect
  schema: unknown
}): ReplySourceRuling {
  return decideReplySource({
    replyFile:
      input.replyFileText === null
        ? { present: false }
        : {
            present: true,
            text: input.replyFileText,
            matches: matchesReplyFile(
              input.contract,
              input.replyFileText,
              input.dialect,
              input.schema,
            ),
          },
    contract: input.contract,
    fallback: {
      text: input.fallbackText,
      matches: matchesFallback(input.contract, input.fallbackText, input.schema),
    },
  })
}
