// concern: workflow cursor stored autonomy
/** Reads a cursor's pinned autonomy snapshot without inventing absent ship-to facts. */

import { storedShipToLevel } from '../../../shared/ship-to.ts'
import type { CursorAutonomyResolution, StoredAutonomyResolution } from './autonomy.ts'
import { cursorName, shellWord } from './workflow-cursor-format.ts'

export type CursorAutonomyRow = {
  id: number
  workflow_slug: string
  project: string
  mode_slug: string
  args: string
  autonomy: string | null
}

export function cursorAutonomy(row: CursorAutonomyRow): CursorAutonomyResolution | undefined {
  if (!row.autonomy) return undefined
  const stored = JSON.parse(row.autonomy) as StoredAutonomyResolution
  const legacyLevel = stored.release ? storedShipToLevel(stored.release.value) : undefined
  const args = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return {
    ...stored,
    ...(!stored.shipTo && stored.release && legacyLevel
      ? { shipTo: { ...stored.release, value: legacyLevel } }
      : {}),
    cursor: {
      id: row.id,
      composeCommand:
        `orch workflow compose ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} ` +
        `--mode ${shellWord(row.mode_slug)}${args}`,
    },
  }
}

export function refuseTerminalCursorBeforeComposition(
  row: CursorAutonomyRow & { state: string; workflow_key: string },
): void {
  if (row.state === 'done' || row.state === 'abandoned')
    throw new Error(
      `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key)} is ${row.state}; compose it again to start a new run`,
    )
}
