// concern: branch-conversation-owner
/** Decides whether an existing branch is already owned by another live conversation. */

export type BranchConversationRow = {
  record_id: string
  number: number
  parent_run_record_id: string | null
  status: string
  branch: string | null
  job: string
  writesRepo: boolean
}

/** Return the first live run on this branch from a different conversation. */
export function aliveBranchConversationOwner(
  rows: readonly BranchConversationRow[],
  branch: string,
  conversationRootId: string | null,
): BranchConversationRow | null {
  return (
    rows.find(
      (row) =>
        row.branch === branch &&
        row.writesRepo &&
        (row.status === 'running' || row.status === 'asking') &&
        (conversationRootId === null ||
          (row.parent_run_record_id ?? row.record_id) !== conversationRootId),
    ) ?? null
  )
}
