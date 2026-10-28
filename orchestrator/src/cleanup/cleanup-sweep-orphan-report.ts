// concern: cleanup sweep orphan reporting

import type { Project } from '../project/projects.ts'
import type { DockerResource } from '../resources/docker-resources.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { resourcesForConversation } from './cleanup.ts'
import {
  decideFilesystemOrphanAfterInventory,
  type decideFilesystemOrphanAfterRemoval,
} from './cleanup-sweep-decisions.ts'

export function reportOrphanAfterRemovalKeep(
  ruling: ReturnType<typeof decideFilesystemOrphanAfterRemoval>,
  label: string,
  sharers: { record_id: string; status: string }[],
  keep: (line: string, reason: string) => void,
  presentation: CleanupPresentation,
): { kept: boolean; failed: boolean } {
  if (ruling.ownershipWarning) presentation.error(`${label}: ${ruling.ownershipWarning}`)
  if (ruling.action === 'removal-refused') {
    keep(`${label}  ${ruling.keepLine}`, ruling.keepReason!)
    presentation.error(`could not reclaim ${label}: ${ruling.error}`)
    return { kept: true, failed: ruling.cleanupFailed }
  }
  if (ruling.action === 'shared-after') {
    const owners = sharers.map((owner) => `${owner.record_id} (${owner.status})`).join(', ')
    keep(`${label}  ${ruling.keepLine}: ${owners}`, ruling.keepReason!)
    presentation.error(`could not reclaim ${label}: acquired during cleanup by run(s) ${owners}`)
    return { kept: true, failed: ruling.cleanupFailed }
  }
  return { kept: false, failed: ruling.cleanupFailed }
}

export function finishRemovedOrphan(input: {
  runId: string | null
  project: Project
  label: string
  detail: string
  output?: string
  branch: string | null
  ownersBefore: { record_id: string }[]
  ownersAfter: { record_id: string }[]
  inventoryErrors: Set<string>
  leaked: Map<string, { resource: DockerResource; project: string; runId: string }>
  keep: (line: string, reason: string) => void
  presentation: CleanupPresentation
}): { released: boolean; failed: boolean } {
  const inventory = input.runId
    ? resourcesForConversation(input.runId)
    : { ascertainable: true as const, resources: [] }
  const inventoryReason = inventory.ascertainable ? null : inventory.reason
  const resources = inventory.ascertainable ? inventory.resources : []
  const ruling = decideFilesystemOrphanAfterInventory({
    runIdPresent: input.runId !== null,
    inventory: !inventory.ascertainable ? 'unavailable' : resources.length ? 'leaked' : 'empty',
  })
  if (ruling.action === 'inventory-unavailable') {
    input.inventoryErrors.add(inventoryReason!)
    input.keep(`${input.label}  ${ruling.keepLine}`, ruling.keepReason)
    return { released: false, failed: ruling.cleanupFailed }
  }
  if (ruling.action === 'leaked') {
    for (const resource of resources)
      input.leaked.set(`${resource.kind}:${resource.name}`, {
        resource,
        project: input.project.name,
        runId: resource.runId,
      })
    input.keep(`${input.label}  ${ruling.keepLine}`, ruling.keepReason!)
    return { released: false, failed: ruling.cleanupFailed }
  }
  input.presentation.log(`reclaimed ${input.label}  ${input.detail}`)
  if (input.output) input.presentation.log(input.output)
  const owner = input.ownersAfter[0] ?? input.ownersBefore[0] ?? null
  if (owner && input.branch)
    input.presentation.log(`branch ${input.branch} left because run ${owner.record_id} records it`)
  return { released: true, failed: ruling.cleanupFailed }
}
