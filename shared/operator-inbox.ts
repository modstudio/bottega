export type OperatorInboxKind = 'question' | 'workflow'

/** Canonical hub route for an item waiting on an operator ruling. */
export const operatorInboxPath = (kind: OperatorInboxKind, id: number): string =>
  `/inbox/${kind}/${id}`
