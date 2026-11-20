// concern: Codex post-launch confinement gap fixture paths

import { join } from 'node:path'

export function codexGapAccessTargets(root: string, ownPath: string) {
  return [
    {
      name: 'new sibling worktree',
      path: join(ownPath, '.claude', 'worktrees', 'created-after-codex-launch', 'secret'),
      expected: 'readable' as const,
    },
    {
      name: 'new project under projects root',
      path: join(root, 'projects', 'created-after-codex-launch', 'secret'),
      expected: 'readable' as const,
    },
    {
      name: 'new top-level entry in main checkout',
      path: join(ownPath, 'created-after-codex-launch', 'secret'),
      expected: 'readable' as const,
    },
  ]
}
