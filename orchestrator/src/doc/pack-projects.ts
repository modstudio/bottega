// concern: pack-projects
/** Gathers authority and register facts for projects that receive pack-wide canon checks. */

import { declaredRecordSpace } from '../project/declared-record-space.ts'
import type { Project } from '../project/projects.ts'
import { hostedRecordOwnsHostedTables } from '../record/record-write-authority.ts'
import { projectGetsPack } from './project-gets-pack.ts'

export function packProjects(registered: Project[]): Project[] {
  const hostedRead = hostedRecordOwnsHostedTables()
  return registered.filter((project) =>
    projectGetsPack({
      retiredAt: project.retiredAt,
      declaredSpace: declaredRecordSpace(project.settings),
      hostedRead,
    }),
  )
}
