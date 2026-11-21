// concern: context-item-vocabulary
/** Context-item values shared by local policy, hosted validation, and storage schemas. */
export const CONTEXT_ITEM_KINDS = ['ruling', 'position', 'fact', 'pointer'] as const
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number]

export const CONTEXT_HOLDER_KINDS = ['task', 'session', 'cursor'] as const
export type ContextHolderKind = (typeof CONTEXT_HOLDER_KINDS)[number]

/** The context-item read payload shared by local and hosted persistence. */
export type StoredContextItem = {
  recordId: string
  holder: string
  id: string
  kind: ContextItemKind
  body: string
  source: string
  questionNumber: number | null
  target: string | null
  revision: string
  createdAt: string
  updatedAt: string
}

/** One holder and its items as returned by context-holder catalogue reads. */
export type ContextItemHolderGroup = {
  holder: string
  holderId: string
  updatedAt: string
  items: StoredContextItem[]
}

/** Builds the single holder-group representation used by both persistence modes. */
export function contextItemHolderGroup(
  holder: string,
  items: StoredContextItem[],
): ContextItemHolderGroup {
  const { holderId } = splitContextHolder(holder)
  return {
    holder,
    holderId,
    updatedAt: items.reduce(
      (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
      items[0]!.updatedAt,
    ),
    items,
  }
}

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
