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

/** Whether the item belongs to the user's personal space rather than the active space. */
export function isPersonalItem(userId: string, target: PersonalItemTarget): boolean {
  return target.kind === 'config-entry'
    ? target.scope === 'user'
    : (target.scope === 'settings' || target.scope === 'canon') &&
        target.subject === null &&
        target.ownerUserId === userId
}

/** Selects the record space that owns an item; callers retain active-space behavior for non-personal items. */
export function resolvePersonalItemSpace(
  identity: PersonalItemIdentity,
  target: PersonalItemTarget,
): string | null {
  return isPersonalItem(identity.userId, target) ? identity.personalSpaceId : identity.activeSpaceId
}
