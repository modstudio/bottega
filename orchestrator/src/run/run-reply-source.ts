// concern: run-reply-source
/**
 * Knows which collected reply source becomes the public output. Must not know
 * files, stores, processes, or run terminalisation.
 */
import { REPLY_FILE_NAME, type ReplyDialect, TEXT_REPLY_SCHEMA } from '../contract/contract.ts'
import type { JsonSchema } from '../contract/contract-reply.ts'
import { valueMatchesReplySchema } from '../contract/contract-reply-validator.ts'
import { schemaMismatchError, valueMatchesStrictSchema } from '../transport/transport.ts'

export type ReplyContract = 'none' | 'text' | 'custom'

export function replyContract(
  schemaPath: string | undefined,
  textReplyContract: boolean,
): ReplyContract {
  if (schemaPath) return 'custom'
  return textReplyContract ? 'text' : 'none'
}

export type ReplySourceFacts = {
  replyFile:
    | { present: false }
    | { present: true; text: string; matches: boolean; failures: string[]; parsed: unknown }
  contract: ReplyContract
  fallback: { text: string; matches: boolean; failures: string[] }
}

export type ReplySourceRuling = {
  output: string
  replyFileError: string | null
  replyFilePresent: boolean
  replyFileValue: unknown
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
        : `${REPLY_FILE_NAME} did not match the worker contract: ${facts.replyFile.failures.join('; ')}\n${facts.replyFile.text}`,
      replyFilePresent: true,
      replyFileValue: facts.replyFile.parsed,
      rewriteOutputFile: true,
    }
  }

  const output =
    facts.contract === 'text' && facts.fallback.matches
      ? unwrapTextReply(facts.fallback.text)
      : facts.fallback.text
  return {
    output,
    replyFileError: !facts.fallback.matches
      ? `${REPLY_FILE_NAME} missing; final message ${schemaMismatchError(facts.fallback.text, facts.fallback.failures)}`
      : null,
    replyFilePresent: false,
    replyFileValue: null,
    rewriteOutputFile: facts.contract === 'text',
  }
}

function parseReplyFile(
  contract: ReplyContract,
  text: string,
  dialect: ReplyDialect,
  schema: unknown,
): { matches: boolean; failures: string[]; parsed: unknown } {
  if (contract !== 'custom') {
    const result = dialect.parse(text)
    if (result.reply !== null) return { matches: true, failures: [], parsed: result.reply }
    try {
      return { matches: false, failures: result.failures, parsed: JSON.parse(text) as unknown }
    } catch (error) {
      return {
        matches: false,
        failures: [`not JSON: ${error instanceof Error ? error.message : String(error)}`],
        parsed: null,
      }
    }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const validation = valueMatchesReplySchema(parsed, schema as JsonSchema)
    return validation.ok
      ? { matches: true, failures: [], parsed }
      : { matches: false, failures: validation.failures, parsed }
  } catch (error) {
    return {
      matches: false,
      failures: [`not JSON: ${error instanceof Error ? error.message : String(error)}`],
      parsed: null,
    }
  }
}

function matchesFallback(
  contract: ReplyContract,
  text: string,
  dialect: ReplyDialect,
  schema: unknown,
): { matches: boolean; failures: string[] } {
  if (contract === 'none') {
    const result = dialect.parse(text)
    return { matches: result.reply !== null, failures: result.failures }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      matches: false,
      failures: [`not JSON: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const validation =
    contract === 'text'
      ? valueMatchesStrictSchema(TEXT_REPLY_SCHEMA, value)
      : valueMatchesStrictSchema(schema, value)
  return validation.ok
    ? { matches: true, failures: [] }
    : { matches: false, failures: validation.failures }
}

/** Apply one reply-file and contract-validation decision for live and processless workers. */
export function collectReplySource(input: {
  replyFileText: string | null
  fallbackText: string
  contract: ReplyContract
  dialect: ReplyDialect
  schema: unknown
}): ReplySourceRuling {
  const parsedReplyFile =
    input.replyFileText === null
      ? null
      : parseReplyFile(input.contract, input.replyFileText, input.dialect, input.schema)
  return decideReplySource({
    replyFile:
      input.replyFileText === null
        ? { present: false }
        : {
            present: true,
            text: input.replyFileText,
            matches: parsedReplyFile!.matches,
            failures: parsedReplyFile!.failures,
            parsed: parsedReplyFile!.parsed,
          },
    contract: input.contract,
    fallback: {
      text: input.fallbackText,
      ...matchesFallback(input.contract, input.fallbackText, input.dialect, input.schema),
    },
  })
}
