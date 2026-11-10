// concern: workflow-read-space
/** Adapts install, project, and cached-route facts into the pure workflow read-space decision. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTIVE_SPACE_REMEDY, recordSpaceMembershipRefusal } from '../../../shared/record-remedies.ts'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import { projectRowByName } from '../project/projects.ts'
import { activeRecordSpace, cachedProjectSpaces, workflowReadSpace } from '../project-space.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'

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
    missingActiveSpaceRefusal: RECORD_ACTIVE_SPACE_REMEDY,
    missingProjectRouteRefusal: missingProjectRoute,
    rejectedProjectRouteRefusal: declaredSpace
      ? recordSpaceMembershipRefusal(declaredSpace)
      : missingProjectRoute,
  })
  if ('refused' in decision) throw new Error(decision.refused)
  return decision.spaceId
}
