// concern: board-reply-audience
/** Validates a reply's audience choice and resolves it from captured thread facts. */
import { parseAudience } from './board-policy.ts'

export type ReplyAudienceOption =
  | 'participants'
  | 'acknowledged'
  | 'audience'
  | 'operator'
  | `session:${string}`
  | `run:${string}`

export function parseReplyAudienceOption(value: string): ReplyAudienceOption {
  if (value === 'participants' || value === 'acknowledged' || value === 'audience') return value
  const audience = parseAudience(value)
  if (audience.kind === 'operator' || audience.kind === 'session' || audience.kind === 'run')
    return value as ReplyAudienceOption
  throw new Error(
    `unsupported reply audience ${value}; use participants, acknowledged, audience, operator, session:<id>, or run:<id>`,
  )
}

export function resolveReplyReaders(input: {
  rootAuthor: string
  threadAuthors: readonly string[]
  rootReceipts: readonly {
    reader: string
    audienceAtPosting: boolean
    acknowledged: boolean
  }[]
  audience: ReplyAudienceOption | null
  replier: string
}): string[] {
  const chosen = input.audience ?? 'participants'
  let readers: string[]
  if (chosen === 'participants') readers = [input.rootAuthor, ...input.threadAuthors]
  else if (chosen === 'acknowledged')
    readers = input.rootReceipts
      .filter((receipt) => receipt.acknowledged)
      .map((receipt) => receipt.reader)
  else if (chosen === 'audience')
    readers = input.rootReceipts
      .filter((receipt) => receipt.audienceAtPosting)
      .map((receipt) => receipt.reader)
  else if (chosen === 'operator') readers = ['operator']
  else if (chosen.startsWith('session:')) readers = [chosen.slice('session:'.length)]
  else readers = [chosen]
  return [...new Set([input.rootAuthor, ...readers])].filter((reader) => reader !== input.replier)
}
