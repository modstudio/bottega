// concern: board-reply-audience
/** Validates a reply's audience choice and resolves it from captured thread facts. */
import {
  REPLY_AUDIENCE_OPTIONS,
  type ReplyAudienceOption,
} from '../../../shared/board-reply-audience-options.ts'
import { OPERATOR_READER } from './board-policy.ts'

export type { ReplyAudienceOption } from '../../../shared/board-reply-audience-options.ts'

export function parseReplyAudienceOption(value: string): ReplyAudienceOption {
  if (REPLY_AUDIENCE_OPTIONS.includes(value as (typeof REPLY_AUDIENCE_OPTIONS)[number]))
    return { kind: value as (typeof REPLY_AUDIENCE_OPTIONS)[number] }
  const prefix = 'session:'
  if (value.startsWith(prefix) && value.length > prefix.length)
    return { kind: 'session', sessionId: value.slice(prefix.length) }
  throw new Error(
    `unsupported reply audience ${value}; use participants, acknowledged, audience, operator, or session:<id>; session:<id> loops that session into the thread`,
  )
}

export function resolveReplyReaders(input: {
  rootAuthor: string
  threadAuthors: readonly string[]
  loopedInSessions: readonly string[]
  rootReceipts: readonly {
    reader: string
    audienceAtPosting: boolean
    acknowledged: boolean
  }[]
  audience: ReplyAudienceOption | null
  replier: string
}): string[] {
  const chosen = input.audience ?? { kind: 'participants' }
  let readers: string[]
  if (chosen.kind === 'participants')
    readers = [input.rootAuthor, ...input.threadAuthors, ...input.loopedInSessions]
  else if (chosen.kind === 'acknowledged')
    readers = input.rootReceipts
      .filter((receipt) => receipt.acknowledged)
      .map((receipt) => receipt.reader)
  else if (chosen.kind === 'audience')
    readers = input.rootReceipts
      .filter((receipt) => receipt.audienceAtPosting)
      .map((receipt) => receipt.reader)
  else if (chosen.kind === 'operator') readers = [OPERATOR_READER]
  else readers = [chosen.sessionId]
  return [...new Set([input.rootAuthor, ...readers])].filter((reader) => reader !== input.replier)
}

export function mergeReplyAudienceReceipts(
  stored: readonly {
    reader: string
    audienceAtPosting: boolean | number
    acknowledged: boolean | string | null
  }[],
  audienceReaders: readonly string[],
) {
  const receipts = new Map(
    stored.map((receipt) => [
      receipt.reader,
      {
        reader: receipt.reader,
        audienceAtPosting: receipt.audienceAtPosting === true || receipt.audienceAtPosting === 1,
        acknowledged:
          typeof receipt.acknowledged === 'boolean'
            ? receipt.acknowledged
            : receipt.acknowledged !== null,
      },
    ]),
  )
  for (const reader of audienceReaders)
    receipts.set(reader, {
      reader,
      audienceAtPosting: true,
      acknowledged: receipts.get(reader)?.acknowledged ?? false,
    })
  return [...receipts.values()]
}
