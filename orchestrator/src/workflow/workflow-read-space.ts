// concern: workflow-read-space
/** Adapts install, project, and cached-route facts into the pure workflow read-space decision. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { projectRowByName } from '../project/projects.ts'
import { activeRecordSpace, cachedProjectSpaces, workflowReadSpace } from '../project-space.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'
import {
  declaredRecordSpace,
  noActiveRecordSpaceRefusal,
  recordSpaceMembershipRefusal,
} from '../record/record-project-destination.ts'

const missingProjectRouteRefusal = (project: string) =>
  `project ${project} route unknown, run \`${PLATFORM_SLUG} record sync\``

export function workflowReadSpaceFor(local: Database, project: string | null): string | null {
  const projectSpaces = cachedProjectSpaces(local)
  const projectSpace = project ? projectSpaces[project] : undefined
  const declaredSpace = project
    ? declaredRecordSpace(projectRowByName(project, local)?.settings)
    : null
  const missingProjectRoute = project ? missingProjectRouteRefusal(project) : ''
  const decision = workflowReadSpace({
    project,
    projectSpace,
    activeSpace: activeRecordSpace(local),
    localAuthoritative: !readRecordInstallBinding(local).bound,
    missingActiveSpaceRefusal: noActiveRecordSpaceRefusal(),
    missingProjectRouteRefusal: missingProjectRoute,
    rejectedProjectRouteRefusal: declaredSpace
      ? recordSpaceMembershipRefusal(declaredSpace)
      : missingProjectRoute,
  })
  if ('refused' in decision) throw new Error(decision.refused)
  return decision.spaceId
}
