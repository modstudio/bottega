export const RECORD_SIGN_IN_REMEDY =
  'record session is missing or expired; run `orch record sign-in --email <email>`'
export const RECORD_ACTIVE_SPACE_REMEDY =
  'record session has no active space; run `orch record space switch <slug>`'

export const pinnedSpaceMismatchRemedy = (pinned: string) =>
  `record active space differs from this machine's initialized hosted-config space; switch back to ${pinned}, or remove this machine's hosted-config bootstrap and initialize it for the other space`

export const pinnedUserMismatchRemedy = (pinned: string) =>
  `record signed-in user differs from this machine's initialized hosted-config user; sign back in as ${pinned}, or remove this machine's hosted-config bootstrap and initialize it for the other user`
