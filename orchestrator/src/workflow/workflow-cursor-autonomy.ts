// concern: workflow cursor stored autonomy
/** Reads a cursor's pinned autonomy snapshot without inventing absent ship-to facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { storedShipToLevel } from '../../../shared/ship-to.ts'
import type { CursorAutonomyResolution, StoredAutonomyResolution } from './autonomy.ts'
import { shellWord } from './workflow-cursor-format.ts'
export type CursorAutonomyRow = {
  id: number
  workflow_slug: string
  project: string
  mode_slug: string
  args: string
  autonomy: string | null
}

export function mapStoredAutonomyResolution(
  stored: StoredAutonomyResolution,
): StoredAutonomyResolution {
  const legacyLevel = stored.release ? storedShipToLevel(stored.release.value) : undefined
  return {
    ...stored,
    ...(!stored.shipTo && stored.release && legacyLevel
      ? { shipTo: { ...stored.release, value: legacyLevel } }
      : {}),
  }
}

export function cursorAutonomy(row: CursorAutonomyRow): CursorAutonomyResolution | undefined {
  if (!row.autonomy) return undefined
  const stored = mapStoredAutonomyResolution(JSON.parse(row.autonomy) as StoredAutonomyResolution)
  const args = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  return {
    ...stored,
    cursor: {
      id: row.id,
      composeCommand:
        `${PLATFORM_SLUG} workflow compose ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} ` +
        `--mode ${shellWord(row.mode_slug)}${args}`,
    },
  }
}
