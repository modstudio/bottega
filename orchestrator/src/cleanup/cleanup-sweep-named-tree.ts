// concern: cleanup sweep named tree hold
/** Marks filesystem-orphan candidates held by open cursors or live runs. */

import { readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export function holdNamedFilesystemOrphans(
  namedTrees: Set<string>,
  root: string,
  project: string,
  remembered: Set<string>,
  keep: (line: string, reason: string) => void,
  addHeld: (project: string, path: string) => void,
): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    const canonical = realpathSync(path)
    if (!namedTrees.has(canonical)) continue
    keep(
      `orphan  ${path}  named by an open cursor or live run`,
      'tree held because an open cursor or live run names it',
    )
    addHeld(project, path)
    remembered.add(canonical)
  }
}
