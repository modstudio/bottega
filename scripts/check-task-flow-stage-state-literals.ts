import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sourceFiles } from './source-analysis.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const DECLARATION = 'orchestrator/src/record/record-task-flow-contract.ts'
const STAGE_STATE = /['"](running|awaiting-ruling|done|abandoned)['"]/g
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
  {
    path: 'orchestrator/src/record/record-board-claims.ts',
    line: "                AND state IN ('running','awaiting-ruling')",
    reason: 'a literal hosted predicate lets Postgres prove the partial-index implication',
  },
  {
    path: 'orchestrator/src/record/record-question-read.ts',
    line: "       WHERE stage.session_id=$1 AND stage.state NOT IN ('done','abandoned')",
    reason: 'a literal hosted predicate lets Postgres prove the partial-index implication',
  },
  {
    path: 'orchestrator/src/record/record-task-flow.ts',
    line: "     AND open_stage.state NOT IN ('done','abandoned')) open_stage_count,",
    reason: 'a literal hosted predicate lets Postgres prove the partial-index implication',
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

export function taskFlowStageStateLiteralRestatements(root = ROOT): string[] {
  return sourceFiles(root, ['orchestrator/src', 'shared'], (path) => {
    return (path.endsWith('.ts') || path.endsWith('.sql')) && path !== DECLARATION
  }).flatMap((path) =>
    readFileSync(`${root}/${path}`, 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        const states = new Set([...line.matchAll(STAGE_STATE)].map((match) => match[1]))
        return states.size >= 2 &&
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
