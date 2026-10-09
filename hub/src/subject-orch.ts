// concern: subject-orch
/** Reads the project subject catalogue through the orchestrator CLI. */

import { jsonDocument } from './orch.ts'
import type { SubjectList } from './subject-contract.ts'

export const projectSubjectList = (project: string, includeRetired = false) =>
  jsonDocument<SubjectList>([
    'subject',
    'list',
    project,
    ...(includeRetired ? ['--retired'] : []),
    '--json',
  ])
