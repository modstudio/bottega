// concern: hosted task-flow stage-list query
/** Builds bounded stage-list predicates and opaque keyset continuations. */

import {
  decodeTaskFlowStageListCursor,
  encodeTaskFlowStageListCursor,
  type TaskFlowStageListQuery,
} from './record-task-flow-contract.ts'

export type TaskFlowStageListSql = {
  values: unknown[]
  clauses: string[]
  orderBy: string
}

function appendCursor(input: TaskFlowStageListQuery, result: TaskFlowStageListSql): void {
  if (!input.cursor) return
  const cursor = decodeTaskFlowStageListCursor(input.cursor)
  if (cursor.order === 'newest') {
    if (cursor.number !== null) result.values.push(cursor.number)
    const numberParameter = cursor.number === null ? null : `$${result.values.length}`
    result.values.push(cursor.id)
    const idParameter = `$${result.values.length}`
    result.clauses.push(
      cursor.number === null
        ? `(s.number IS NULL AND s.id<${idParameter}::uuid)`
        : `(s.number<${numberParameter}::integer OR s.number IS NULL OR
            (s.number=${numberParameter}::integer AND s.id<${idParameter}::uuid))`,
    )
    return
  }
  result.values.push(cursor.projectName)
  const projectParameter = `$${result.values.length}`
  result.values.push(cursor.number)
  const numberParameter = `$${result.values.length}`
  result.values.push(cursor.id)
  const idParameter = `$${result.values.length}`
  const afterWithinProject =
    cursor.number === null
      ? `(s.number IS NULL AND s.id>${idParameter}::uuid)`
      : `(s.number>${numberParameter}::integer OR s.number IS NULL OR
          (s.number=${numberParameter}::integer AND s.id>${idParameter}::uuid))`
  result.clauses.push(
    cursor.projectName === null
      ? `(sp.name IS NULL AND ${afterWithinProject})`
      : `(sp.name>${projectParameter} OR sp.name IS NULL OR
          (sp.name=${projectParameter} AND ${afterWithinProject}))`,
  )
}

export function taskFlowStageListSql(
  spaceId: string,
  input: TaskFlowStageListQuery,
): TaskFlowStageListSql {
  const result: TaskFlowStageListSql = {
    values: [spaceId],
    clauses: ['s.space_id=$1::uuid'],
    orderBy:
      input.order === 'newest'
        ? 's.number DESC NULLS LAST,s.id DESC'
        : 'sp.name,s.number NULLS LAST,s.id',
  }
  const add = (clause: (parameter: string) => string, value: unknown) => {
    result.values.push(value)
    result.clauses.push(clause(`$${result.values.length}`))
  }
  if (input.projectId) add((parameter) => `s.project_id=${parameter}::uuid`, input.projectId)
  if (input.number !== undefined)
    add((parameter) => `s.number=${parameter}::integer`, input.number)
  if (input.sessionId) add((parameter) => `s.session_id=${parameter}`, input.sessionId)
  if (input.states) {
    const parameters = input.states.map((state) => {
      result.values.push(state)
      return `$${result.values.length}`
    })
    result.clauses.push(`s.state IN (${parameters.join(',')})`)
  }
  if (input.taskKey) add((parameter) => `t.key=${parameter}`, input.taskKey)
  if (input.workflow) add((parameter) => `s.workflow=${parameter}`, input.workflow)
  if (input.mode) add((parameter) => `s.mode=${parameter}`, input.mode)
  if (input.workflowKey) add((parameter) => `s.workflow_key=${parameter}`, input.workflowKey)
  if (input.keyless) result.clauses.push("s.workflow_key=''")
  if (input.primaryInstance) result.clauses.push("s.instance_id=''")
  if (input.taskId) add((parameter) => `f.task_id=${parameter}::uuid`, input.taskId)
  if (input.unlinked) result.clauses.push('f.task_id IS NULL')
  appendCursor(input, result)
  return result
}

export function taskFlowStageListNextCursor(
  input: TaskFlowStageListQuery,
  row: Record<string, unknown> | undefined,
): string | null {
  if (!row) return null
  const common = {
    number: row.stage_number == null ? null : Number(row.stage_number),
    id: String(row.stage_id),
  }
  return encodeTaskFlowStageListCursor(
    input.order === 'newest'
      ? { order: 'newest', ...common }
      : {
          order: 'project',
          projectName: row.stage_project_name == null ? null : String(row.stage_project_name),
          ...common,
        },
  )
}
