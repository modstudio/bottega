export type PersonalItemIdentity = {
  userId: string
  activeSpaceId: string | null
  personalSpaceId: string | null
}

export type PersonalItemTarget =
  | {
      kind: 'document'
      scope: string
      subject: string | null
      ownerUserId: string | null
    }
  | { kind: 'config-entry'; scope: 'user' | 'space' }

/** Selects the record space that owns an item; callers retain active-space behavior for non-personal items. */
export function resolvePersonalItemSpace(
  identity: PersonalItemIdentity,
  target: PersonalItemTarget,
): string | null {
  const personal =
    target.kind === 'config-entry'
      ? target.scope === 'user'
      : (target.scope === 'settings' || target.scope === 'canon') &&
        target.subject === null &&
        target.ownerUserId === identity.userId
  return personal ? identity.personalSpaceId : identity.activeSpaceId
}
