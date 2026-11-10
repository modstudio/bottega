// concern: declared-project-space
/** Decides whether a registered project declares its record space. */

import { undeclaredProjectSpaceRefusal } from '../../../shared/record-remedies.ts'
import { declaredRecordSpace } from './declared-record-space.ts'
import type { Project } from './projects.ts'

export function declaredProjectSpace(
  project: Pick<Project, 'name' | 'settings'>,
): { space: string } | { refused: string } {
  const space = declaredRecordSpace(project.settings)
  return space
    ? { space }
    : {
        refused: undeclaredProjectSpaceRefusal(project.name),
      }
}
