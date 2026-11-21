import { expect, test } from 'bun:test'
import { mutableArtifactFreshnessRefusal } from './workflow-floor-artifact-freshness.ts'

const activatedAt = '2026-11-21T12:00:00.000Z'

test.each(['doc', 'task comment', 'task document', 'note', 'attached text'])(
  '%s must be written during the active step',
  (kind) => {
    expect(
      mutableArtifactFreshnessRefusal(kind, '2026-11-21T11:59:59.999Z', activatedAt),
    ).toContain(`write or change the ${kind} record during this step, then cite it`)
    expect(
      mutableArtifactFreshnessRefusal(kind, '2026-11-21T12:00:00.001Z', activatedAt),
    ).toBeNull()
  },
)
