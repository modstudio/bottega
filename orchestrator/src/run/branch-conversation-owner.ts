// concern: branch-conversation-owner
/** Decides whether an existing branch is already owned by another live conversation. */

export type BranchConversationRow = {
  id: number
  parent_run_id: number | null
  status: string
  branch: string | null
}

/** Return the first live run on this branch from a different conversation. */
export function aliveBranchConversationOwner(
  rows: readonly BranchConversationRow[],
  branch: string,
  conversationRootId: number | null,
): BranchConversationRow | null {
  return (
    rows.find(
      (row) =>
        row.branch === branch &&
        (row.status === 'running' || row.status === 'asking') &&
        (conversationRootId === null || (row.parent_run_id ?? row.id) !== conversationRootId),
    ) ?? null
  )
}
