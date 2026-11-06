// concern: doc-context-write
/** Pure write policy for one structured context item. */

export const CONTEXT_ITEM_KINDS = [
  'ruling',
  'position',
  'open-question',
  'pointer',
  'next-action',
] as const
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number]

export const CONTEXT_ITEM_MAX_CHARS = {
  ruling: 1500,
  position: 800,
  'open-question': 800,
  pointer: 400,
  'next-action': 400,
} as const satisfies Record<ContextItemKind, number>

export type ContextProfile = 'epic' | 'task' | 'session'
export type ContextItem = {
  holder: string
  id: string
  kind: ContextItemKind
  source: string
  objection?: string
  body: string
}
export type ContextWriteFacts = {
  profile: ContextProfile
  siblings: ContextItem[]
  related: ContextItem[]
  pointerRefusal: string | null
  claimedTask: string | null
}

const PROFILE = {
  epic: { allowed: ['ruling', 'next-action'], required: ['next-action'] },
  task: { allowed: CONTEXT_ITEM_KINDS, required: ['next-action'] },
  session: {
    allowed: ['pointer', 'position', 'next-action', 'ruling', 'open-question'],
    required: ['next-action'],
  },
} as const satisfies Record<
  ContextProfile,
  { allowed: readonly ContextItemKind[]; required: readonly ContextItemKind[] }
>

function normalizeContextBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function contextWriteRefusal(item: ContextItem, facts: ContextWriteFacts): string | null {
  const address = `context item ${item.id}`
  const profile = PROFILE[facts.profile]
  if (!(profile.allowed as readonly ContextItemKind[]).includes(item.kind)) {
    return `${address} refused: ${facts.profile} profile does not allow kind ${item.kind}`
  }
  if (!item.source.trim()) return `${address} refused: every item requires a non-empty source`
  if (item.body.length > CONTEXT_ITEM_MAX_CHARS[item.kind]) {
    return `${address} refused: ${item.kind} limit is ${CONTEXT_ITEM_MAX_CHARS[item.kind]} characters`
  }
  const ruling = rulingRefusal(item, address)
  if (ruling) return ruling
  if (
    facts.profile === 'session' &&
    facts.claimedTask &&
    ['ruling', 'open-question'].includes(item.kind)
  ) {
    return `${address} refused: task-level ${item.kind} written to a session; write it to task:${facts.claimedTask}`
  }
  if (item.kind === 'pointer' && facts.pointerRefusal) {
    return `${address} refused: ${facts.pointerRefusal}`
  }
  if (
    item.kind === 'next-action' &&
    facts.siblings.some((sibling) => sibling.kind === 'next-action' && sibling.id !== item.id)
  ) {
    return `${address} refused: holder ${item.holder} allows at most one next-action item`
  }
  const normalized = normalizeContextBody(item.body)
  for (const other of facts.related) {
    const related = normalizeContextBody(other.body)
    if (normalized === related || (normalized.length >= 80 && related.includes(normalized))) {
      return `${address} refused: restates ${other.holder}/${other.id}; point at that item instead`
    }
  }
  return null
}

function rulingRefusal(item: ContextItem, address: string): string | null {
  if (item.kind !== 'ruling') return null
  if (!item.objection?.trim()) return `${address} refused: a ruling requires a non-empty objection`
  if (item.source !== 'operator' && item.source !== 'agent') {
    return `${address} refused: a ruling source must be operator or agent`
  }
  return null
}

/** Only the session a session holder names may write or drop its items. */
export function holderOwnershipRefusal(
  holder: string,
  caller: string | null,
  id: string,
): string | null {
  if (!holder.startsWith('session:')) return null
  const owner = holder.slice('session:'.length)
  return owner === caller
    ? null
    : `context item ${id} refused: only owning session ${owner} may write ${holder}`
}

export function contextDropRefusal(
  item: ContextItem,
  siblings: ContextItem[],
  profile: ContextProfile,
) {
  const required = PROFILE[profile].required as readonly ContextItemKind[]
  if (
    required.includes(item.kind) &&
    siblings.filter((row) => row.kind === item.kind).length === 1
  ) {
    return `context item ${item.id} refused: cannot remove the last required ${item.kind} item`
  }
  return null
}

export function missingContextKinds(
  items: ContextItem[],
  profile: ContextProfile,
): ContextItemKind[] {
  return PROFILE[profile].required.filter(
    (kind) => !items.some((item) => item.kind === kind),
  ) as ContextItemKind[]
}
