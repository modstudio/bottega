// concern: developer-node
/** Decides whether a source-checkout developer needs a Node prerequisite notice. */

import type { InstallationKind } from '../../../shared/install-root.ts'
import {
  MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR,
  nodeVersionMeetsMinimum,
} from '../../../shared/node-requirement.ts'

export type DeveloperNodeNotice = { message: string; fix: string }

export function developerNodeNotice({
  installationKind,
  nodePath,
  nodeVersion,
}: {
  installationKind: InstallationKind | null
  nodePath: string | null
  nodeVersion: string | null
}): DeveloperNodeNotice | null {
  if (installationKind !== 'checkout') return null
  const minimum = MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR
  if (nodePath === null) {
    return {
      message: `Node is not on PATH; the gate's architecture checks need Node ${minimum} or later`,
      fix: `install Node ${minimum} or later`,
    }
  }
  const repairFix = `install Node ${minimum} or later, or repair the node on PATH`
  if (nodeVersion === null) {
    return {
      message: `could not read a Node version from ${nodePath}; the gate's architecture checks need Node ${minimum} or later`,
      fix: repairFix,
    }
  }
  const meetsMinimum = nodeVersionMeetsMinimum(nodeVersion)
  if (meetsMinimum === true) return null
  return {
    message: `Node ${nodeVersion} is older than Node ${minimum}, which the gate's architecture checks need`,
    fix: `install Node ${minimum} or later`,
  }
}

export function developerNodeDoctorLines(
  installationKind: InstallationKind | null,
  nodePath: string | null,
  nodeVersion: string | null,
): string[] {
  const notice = developerNodeNotice({ installationKind, nodePath, nodeVersion })
  return notice ? [notice.message, `  ${notice.fix}`] : []
}
