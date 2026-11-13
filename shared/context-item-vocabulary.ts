// concern: context-item-vocabulary
/** Context-item values shared by local policy, hosted validation, and storage schemas. */
export const CONTEXT_ITEM_KINDS = [
  'ruling',
  'position',
  'fact',
  'pointer',
  'next-action',
  'open-question',
] as const
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number]

export const CONTEXT_HOLDER_KINDS = ['task', 'session', 'cursor'] as const
export type ContextHolderKind = (typeof CONTEXT_HOLDER_KINDS)[number]

/** Splits a `<kind>:<id>` holder address, refusing an unknown kind or an empty id. */
export function splitContextHolder(holder: string): {
  holderKind: ContextHolderKind
  holderId: string
} {
  const separator = holder.indexOf(':')
  const holderKind = holder.slice(0, separator)
  const holderId = holder.slice(separator + 1)
  if (!(CONTEXT_HOLDER_KINDS as readonly string[]).includes(holderKind) || !holderId) {
    throw new Error(`invalid context holder ${JSON.stringify(holder)}`)
  }
  return { holderKind: holderKind as ContextHolderKind, holderId }
}
