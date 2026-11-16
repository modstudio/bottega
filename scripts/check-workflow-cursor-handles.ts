import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sourceFiles } from './source-analysis.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const FORMATTER = 'orchestrator/src/workflow/workflow-cursor-format.ts'
const BARE_HANDLE = '--cursor ${'

export function bareWorkflowCursorHandles(root = ROOT): string[] {
  return sourceFiles(
    root,
    ['orchestrator/src'],
    (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && path !== FORMATTER,
  ).flatMap((path) =>
    readFileSync(`${root}/${path}`, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        line.includes(BARE_HANDLE) ? [`${path}:${index + 1}: route cursor handles through workflowCursorReference`] : [],
      ),
  )
}

if (import.meta.main) {
  const findings = bareWorkflowCursorHandles()
  for (const finding of findings) console.error(finding)
  if (findings.length) process.exit(1)
  console.log('check-workflow-cursor-handles: ok')
}
