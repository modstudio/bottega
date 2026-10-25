export type OperatorInboxKind = 'question' | 'workflow'

/** Canonical hub route for an item waiting on a person's ruling. */
export const operatorInboxPath = (kind: OperatorInboxKind, id: number): string =>
  `/inbox/${kind}/${id}`
