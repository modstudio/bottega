export const REPLY_AUDIENCE_OPTIONS = [
  'participants',
  'acknowledged',
  'audience',
  'operator',
] as const

export type ReplyAudienceOption =
  | {
      [Kind in (typeof REPLY_AUDIENCE_OPTIONS)[number]]: { kind: Kind }
    }[(typeof REPLY_AUDIENCE_OPTIONS)[number]]
  | { kind: 'session'; sessionId: string }

export function replyAudienceValue(option: ReplyAudienceOption): string {
  return option.kind === 'session' ? `session:${option.sessionId}` : option.kind
}
