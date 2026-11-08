// concern: record-project-space-server
/** Classifies PostgreSQL failures that prove a project id belongs to another space. */

import { postgresServerMessage, postgresSqlState } from '../../../shared/record/postgres-error.ts'

export type ProjectWriteRefusalDecision = 'conflict' | 'unchanged'

export function classifyProjectWriteRefusal(
  sqlState: string | null,
  table: string | null,
): ProjectWriteRefusalDecision {
  return sqlState === '42501' && table === 'project' ? 'conflict' : 'unchanged'
}

function postgresErrorTable(error: unknown): string | null {
  return (
    /for table (?:"([^"]+)"|([^\s]+))(?:\s|$)/
      .exec(postgresServerMessage(error))
      ?.slice(1)
      .find(Boolean) ?? null
  )
}

export function isProjectRowLevelSecurityViolation(error: unknown): boolean {
  return (
    classifyProjectWriteRefusal(postgresSqlState(error), postgresErrorTable(error)) === 'conflict'
  )
}
