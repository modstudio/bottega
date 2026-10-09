// concern: architecture-manifest
/** Project-subject module allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

const module = (file: string, allowed: string[]) => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const subjectModules = [
  module('orchestrator/src/subject/subject-client.ts', [
    '../project/projects.ts',
    '../record/record-api-client.ts',
    '../record/record-project-destination-client.ts',
    '../record/record-subjects.ts',
  ]),
  module('orchestrator/src/subject/subjects.ts', [
    'bun:sqlite',
    '../../../shared/record/schema.ts',
    '../../../shared/subjects.ts',
    '../database/db.ts',
    '../project/projects.ts',
    '../record/record-subjects.ts',
    '../record/record-write-authority.ts',
    './subject-client.ts',
  ]),
  module('orchestrator/src/subject/subject-commands.ts', ['./subjects.ts']),
]
