// concern: declared-project-space
/** Decides whether a registered project declares its record space. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { declaredRecordSpace } from './declared-record-space.ts'
import type { Project } from './projects.ts'

export function declaredProjectSpaceRemedy(project: string): string {
  return `${PLATFORM_SLUG} project set ${project} --space <slug>`
}

export function declaredProjectSpace(
  project: Pick<Project, 'name' | 'settings'>,
): { space: string } | { refused: string } {
  const space = declaredRecordSpace(project.settings)
  return space
    ? { space }
    : {
        refused: `project ${project.name} has no declared record space; run \`${declaredProjectSpaceRemedy(project.name)}\``,
      }
}
