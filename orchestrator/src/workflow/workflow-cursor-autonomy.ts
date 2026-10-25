// concern: workflow cursor stored autonomy
/** Reads a cursor's pinned autonomy snapshot without inventing absent ship-to facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { SHIP_TO_VALUES, storedShipToLevel } from '../../../shared/ship-to.ts'
import {
  type AutonomyResolution,
  autonomyValues,
  type CursorAutonomyDifference,
  type CursorAutonomyResolution,
  type LiveCursorAutonomy,
  type RulingsResolution,
  type StoredAutonomyResolution,
} from './autonomy.ts'
import { shellWord } from './workflow-cursor-format.ts'
export type CursorAutonomyRow = {
  id: number
  record_id: string
  workflow_slug: string
  project: string
  mode_slug: string
  args: string
  autonomy: string | null
}

type ResolutionEntry = { value: string; scope: string }

function stricterEntry<T extends ResolutionEntry>(
  subject: string,
  pinned: T,
  live: T | undefined,
  values: readonly string[],
  differences: CursorAutonomyDifference[],
): T {
  if (!live || live.value === pinned.value) return pinned
  const pinnedRank = values.indexOf(pinned.value)
  const liveRank = values.indexOf(live.value)
  if (pinnedRank < 0 || liveRank < 0) return pinned
  if (liveRank < pinnedRank) return live
  differences.push({ subject, pinned: pinned.value, live: live.value })
  return pinned
}

export function combineCursorRulings(
  pinned: RulingsResolution,
  live: RulingsResolution | undefined,
): RulingsResolution {
  return stricterEntry('rulings', pinned, live, ['user', 'agent'], [])
}

export function combineCursorAutonomy(
  pinned: CursorAutonomyResolution,
  live?: AutonomyResolution,
): {
  resolution: CursorAutonomyResolution
  looserLiveDifferences: CursorAutonomyDifference[]
} {
  if (!live) return { resolution: pinned, looserLiveDifferences: [] }
  const differences: CursorAutonomyDifference[] = []
  const steps = Object.fromEntries(
    Object.entries(pinned.steps).map(([slug, entry]) => [
      slug,
      stricterEntry(`steps.${slug}`, entry, live.steps[slug], autonomyValues, differences),
    ]),
  )
  const stages = pinned.stages
    ? Object.fromEntries(
        Object.entries(pinned.stages).map(([stage, entry]) => [
          stage,
          stricterEntry(
            `stages.${stage}`,
            entry,
            live.stages?.[stage as keyof typeof live.stages],
            autonomyValues,
            differences,
          ),
        ]),
      )
    : undefined
  const rulings = stricterEntry(
    'rulings',
    pinned.rulings,
    live.rulings,
    ['user', 'agent'],
    differences,
  )
  const shipTo = pinned.shipTo
    ? stricterEntry('ship-to', pinned.shipTo, live.shipTo, SHIP_TO_VALUES, differences)
    : undefined
  return {
    resolution: { ...pinned, steps, stages, rulings, shipTo },
    looserLiveDifferences: differences,
  }
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

export function cursorAutonomy(
  row: CursorAutonomyRow,
  live?: LiveCursorAutonomy,
): CursorAutonomyResolution | undefined {
  if (!row.autonomy) return undefined
  const stored = mapStoredAutonomyResolution(JSON.parse(row.autonomy) as StoredAutonomyResolution)
  const args = Object.entries(JSON.parse(row.args) as Record<string, string>)
    .map(([name, value]) => ` --arg ${shellWord(`${name}=${value}`)}`)
    .join('')
  const pinned = {
    ...stored,
    cursor: {
      id: row.id,
      composeCommand:
        `${PLATFORM_SLUG} workflow compose ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} ` +
        `--mode ${shellWord(row.mode_slug)}${args}`,
    },
  } satisfies CursorAutonomyResolution
  const combined = combineCursorAutonomy(pinned, live?.resolution)
  return {
    ...combined.resolution,
    ...(combined.looserLiveDifferences.length
      ? { looserLiveDifferences: combined.looserLiveDifferences }
      : {}),
    ...(live?.unavailableReason ? { liveUnavailableReason: live.unavailableReason } : {}),
  }
}
