// concern: run-reply-source
/**
 * Knows which collected reply source becomes the public output. Must not know
 * files, stores, processes, or run terminalisation.
 */
import {
  REPLY_FILE_NAME,
  type ReplyDialect,
  TEXT_REPLY_SCHEMA,
  validatesSchema,
} from '../contract/contract.ts'
import { schemaMismatchError, valueMatchesStrictSchema } from '../transport/transport.ts'

export type ReplySourceFacts = {
  transportOutput: string
  replyFile: { present: false } | { present: true; text: string }
  validationSchema: unknown | null
  customSchema: boolean
  textContract: boolean
  dialect: ReplyDialect
}

export type ReplySourceRuling = {
  output: string
  replyFileError: string | null
  replyFilePresent: boolean
  rewriteOutputFile: boolean
}

function presentReplyFileMatches(opts: {
  text: string
  schema: unknown
  customSchema: boolean
  dialect: ReplyDialect
}): boolean {
  const schema = opts.schema as Parameters<typeof validatesSchema>[1]
  if (opts.customSchema) {
    let value: unknown
    try {
      value = JSON.parse(opts.text)
    } catch {
      return false
    }
    return validatesSchema(value, schema)
  }
  return opts.dialect.parse(opts.text).reply !== null
}

/** Decide whether the reply file or transport fallback supplies the public result. */
export function decideReplySource(facts: ReplySourceFacts): ReplySourceRuling {
  let output = facts.transportOutput
  let replyFileError: string | null = null

  if (facts.replyFile.present) {
    output = facts.replyFile.text
    if (
      !presentReplyFileMatches({
        text: facts.replyFile.text,
        schema: facts.validationSchema,
        customSchema: facts.customSchema,
        dialect: facts.dialect,
      })
    ) {
      replyFileError = `${REPLY_FILE_NAME} did not match the worker contract:\n${facts.replyFile.text}`
    } else if (facts.textContract) {
      output = (JSON.parse(facts.replyFile.text) as { answer: string }).answer
    }
    return {
      output,
      replyFileError,
      replyFilePresent: true,
      rewriteOutputFile: true,
    }
  }

  if (facts.textContract) {
    // The public result stays plain text. A conforming fallback final message
    // uses the file envelope, while legacy prose remains readable.
    try {
      const value = JSON.parse(output)
      if (valueMatchesStrictSchema(TEXT_REPLY_SCHEMA, value)) output = value.answer
    } catch {
      /* Missing-file fallback may be the legacy plain-text result. */
    }
  }

  if (facts.customSchema) {
    let value: unknown
    try {
      value = JSON.parse(output)
    } catch {
      value = null
    }
    if (!valueMatchesStrictSchema(facts.validationSchema, value)) {
      replyFileError = schemaMismatchError(output)
    }
  }

  return {
    output,
    replyFileError,
    replyFilePresent: false,
    rewriteOutputFile: facts.textContract,
  }
}
