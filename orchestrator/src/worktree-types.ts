// concern: worktree-types
export type Worktree = {
  /** Where the worker actually runs. */
  path: string
  /** The branch created for it. */
  branch: string
  /** The commit it was cut from, so the diff has a fixed floor. */
  base: string
  /** The repository the worktree belongs to. */
  repoRoot: string
  /** The lifecycle that created this tree, and therefore owns its removal. */
  source?: 'recipe' | 'git' | 'readonly_recipe'
  /** Branch this run minted. Null/absent means it must never delete row.branch. */
  mintedBranch?: string | null
}

