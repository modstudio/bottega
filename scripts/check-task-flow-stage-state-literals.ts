import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TASK_FLOW_STAGE_STATES,
  taskFlowStageStateSqlList,
} from '../orchestrator/src/record/record-task-flow-contract.ts'
import { sourceFiles } from './source-analysis.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const DECLARATION = 'orchestrator/src/record/record-task-flow-contract.ts'
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stageStates = taskFlowStageStateSqlList(TASK_FLOW_STAGE_STATES)
  .split(',')
  .map((state) => state.slice(1, -1))
const STAGE_STATE = new RegExp(`['"](${stageStates.map(regexEscape).join('|')})['"]`, 'g')
const ARRAY_LITERAL = /\[[^\[\]]*\]/g
const SQL_IN_LIST = /\b(?:NOT\s+)?IN\s*\([^()]*\)/gi
const EXEMPTIONS = [
  {
    pathPrefix: 'shared/record/migrations/',
    reason: 'record migrations are immutable schema history',
  },
  {
    path: 'shared/record/schema-task-flow.ts',
    line: `      .where(sql\`\${table.state} NOT IN ('done','abandoned')\`),`,
    reason: 'the hosted partial-index predicate requires a schema migration when states change',
  },
] as const

function exemptStageStateLine(path: string, line: string): boolean {
  return EXEMPTIONS.some(
    (exemption) =>
      ('pathPrefix' in exemption && path.startsWith(exemption.pathPrefix)) ||
      ('path' in exemption && exemption.path === path && exemption.line === line),
  )
}

function stageStateContext(path: string, line: string): boolean {
  return (
    path.includes('/workflow/') ||
    path.includes('/question-store/') ||
    path.includes('/board/') ||
    path.includes('/session-losses/') ||
    path.includes('task-flow') ||
    /\bstate\b.*\b(?:IN|NOT IN)\b/.test(line)
  )
}

function distinctStageStates(source: string): Set<string> {
  return new Set([...source.matchAll(STAGE_STATE)].map((match) => match[1]!))
}

function operandsRestateStageStateSet(operands: string[]): boolean {
  const operandStates = operands.map(distinctStageStates).filter((states) => states.size > 0)
  return (
    operandStates.length >= 2 && new Set(operandStates.flatMap((states) => [...states])).size >= 2
  )
}

function restatesStageStateSet(line: string): boolean {
  const literalLists = [...line.matchAll(ARRAY_LITERAL), ...line.matchAll(SQL_IN_LIST)]
  if (literalLists.some((match) => distinctStageStates(match[0]).size >= 2)) return true

  const booleanOperands = line.split(/\|\||&&/)
  if (booleanOperands.length >= 2 && operandsRestateStageStateSet(booleanOperands)) return true

  const typeUnionOperands = line.split(/(?<!\|)\|(?!\|)/)
  return typeUnionOperands.length >= 2 && operandsRestateStageStateSet(typeUnionOperands)
}

export function taskFlowStageStateLiteralRestatements(root = ROOT): string[] {
  return sourceFiles(root, ['orchestrator/src', 'orchestrator/test', 'shared'], (path) => {
    return (path.endsWith('.ts') || path.endsWith('.sql')) && path !== DECLARATION
  }).flatMap((path) =>
    readFileSync(`${root}/${path}`, 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        return restatesStageStateSet(line) &&
          stageStateContext(path, line) &&
          !exemptStageStateLine(path, line)
          ? [
              `${path}:${index + 1}: derive task-flow stage-state sets from record-task-flow-contract`,
            ]
          : []
      }),
  )
}

if (import.meta.main) {
  const findings = taskFlowStageStateLiteralRestatements()
  for (const finding of findings) console.error(finding)
  if (findings.length) process.exit(1)
  console.log('check-task-flow-stage-state-literals: ok')
}
