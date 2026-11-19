// concern: developer-node
/** Decides whether a source-checkout developer needs a Node prerequisite notice. */

import type { InstallationKind } from '../../../shared/install-root.ts'
import {
  MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR,
  nodeVersionMajor,
} from '../../../shared/node-requirement.ts'

export type DeveloperNodeNotice = { message: string; fix: string }

export function developerNodeNotice({
  installationKind,
  nodeVersion,
}: {
  installationKind: InstallationKind | null
  nodeVersion: string | null
}): DeveloperNodeNotice | null {
  if (installationKind !== 'checkout') return null
  const minimum = MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR
  const major = nodeVersion === null ? null : nodeVersionMajor(nodeVersion)
  if (nodeVersion !== null && major !== null && major >= minimum) return null
  return {
    message:
      nodeVersion === null
        ? `Node is not on PATH; the gate's architecture checks need Node ${minimum} or later`
        : `Node ${nodeVersion} is older than Node ${minimum}, which the gate's architecture checks need`,
    fix: `install Node ${minimum} or later`,
  }
}

export function developerNodeDoctorLines(
  installationKind: InstallationKind | null,
  nodeVersion: string | null,
): string[] {
  const notice = developerNodeNotice({ installationKind, nodeVersion })
  return notice ? [notice.message, `  ${notice.fix}`] : []
}
