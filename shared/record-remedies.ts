export const RECORD_SIGN_IN_REMEDY =
  'record session is missing or expired; run `orch record sign-in --email <email>`'
export const RECORD_ACTIVE_SPACE_REMEDY =
  'record session has no active space; run `orch record space switch <slug>`'

export const pinnedSpaceMismatchRemedy = (pinned: string) =>
  `record active space differs from this machine's initialized hosted-config space; switch back to ${pinned}, or re-init this machine for the other space`
