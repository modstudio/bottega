// concern: orphan Compose observation
import { existsSync } from 'node:fs'
import type { dockerRunResources } from '../resources/docker-resources.ts'
import type { MonitorCondition } from './monitor-types.ts'
import { orphanComposeResourceConditions } from './orphan-inventory-conditions.ts'

export function observedOrphanComposeConditions(
  inventory: ReturnType<typeof dockerRunResources>,
): MonitorCondition[] {
  if (!inventory.ascertainable) return []
  return orphanComposeResourceConditions([
    ...(inventory.composeContainers ?? []).flatMap((item) =>
      item.workingDir
        ? [
            {
              kind: 'container' as const,
              name: item.name,
              project: item.composeProject,
              workingDir: item.workingDir,
              workingDirExists: existsSync(item.workingDir),
            },
          ]
        : [],
    ),
  ])
}
