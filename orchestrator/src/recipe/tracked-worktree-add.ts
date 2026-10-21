// concern: tracked recipe worktree creation
/** Builds the git worktree-add command shared by tracked recipe creation forms. */

export type TrackedWorktreeAddInput = {
  branch: string
  path: string
  base: string
  detached: boolean
  existingBranch: boolean
  relativePaths?: boolean
}

/** Build the one git worktree-add shape used by every tracked creation form. */
export function buildTrackedWorktreeAddArgv(input: TrackedWorktreeAddInput): string[] {
  // branch-ref-guard: assertBranchRefMayBeCreated in createTrackedRecipe
  return [
    'worktree',
    'add',
    ...(input.relativePaths ? ['--relative-paths'] : []),
    ...(input.detached ? ['--detach'] : input.existingBranch ? [] : ['-b', input.branch]),
    input.path,
    input.existingBranch && !input.detached ? input.branch : input.base,
  ]
}
