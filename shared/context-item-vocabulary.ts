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
