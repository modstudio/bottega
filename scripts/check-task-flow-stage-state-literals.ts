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
] as const

function exemptStageStateLine(path: string, line: string): boolean {
  return EXEMPTIONS.some(
    (exemption) =>
      ('pathPrefix' in exemption && path.startsWith(exemption.pathPrefix)) ||
      ('path' in exemption && exemption.path === path && exemption.line === line),
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
        return states.size >= 2 && !exemptStageStateLine(path, line)
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
