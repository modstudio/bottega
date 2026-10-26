// concern: harness reply collection
/** Purely classifies the reply artifact for a processless harness run. */

import type { ReplyDialect } from '../contract/contract.ts'
import { REPLY_FILE_NAME } from '../contract/contract.ts'
import { decideReplySource } from './run-reply-source.ts'

export function decideHarnessReply(replyText: string | null, dialect: ReplyDialect) {
  const matches = replyText !== null && dialect.parse(replyText).reply !== null
  const source = decideReplySource({
    replyFile: replyText === null ? { present: false } : { present: true, text: replyText, matches },
    contract: 'custom',
    fallback: { text: '', matches: false },
  })
  const parsed = dialect.parse(source.output)
  const reply = parsed.reply
  const statusReply =
    reply && typeof reply === 'object' && 'status' in reply
      ? (reply as { status: string })
      : null
  const missing = replyText === null
  const invalid = source.replyFileError !== null || reply === null
  return {
    output: source.output,
    reply,
    contractObjects: parsed.contractObjects,
    status: missing || invalid ? ('failed' as const) : statusReply?.status === 'asking' ? ('asking' as const) : ('ok' as const),
    error: missing ? `${REPLY_FILE_NAME} is missing` : source.replyFileError,
    failureKind: missing || invalid ? ('contract' as const) : null,
  }
}
