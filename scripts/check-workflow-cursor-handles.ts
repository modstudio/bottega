import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { sourceFiles } from './source-analysis.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const FORMATTER = 'orchestrator/src/workflow/workflow-cursor-format.ts'
const BARE_HANDLE = '--cursor ${'
const EXEMPTIONS = [
  {
    path: 'orchestrator/src/session/context-review.ts',
    line: "  if (reference.kind === 'cursor') return `--cursor ${shellQuote(reference.key)}`",
    reason:
      'the context holder key is a globally unique cursor record id, not a workflow cursor number',
  },
] as const

function exemptBareHandle(path: string, line: string): boolean {
  return EXEMPTIONS.some((exemption) => exemption.path === path && exemption.line === line)
}

export function bareWorkflowCursorHandles(root = ROOT): string[] {
  return sourceFiles(
    root,
    ['orchestrator/src'],
    (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && path !== FORMATTER,
  ).flatMap((path) =>
    readFileSync(`${root}/${path}`, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        line.includes(BARE_HANDLE) && !exemptBareHandle(path, line)
          ? [`${path}:${index + 1}: route cursor handles through workflowCursorReference`]
          : [],
      ),
  )
}

function propertyName(node: ts.PropertyAssignment): string | null {
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
}

function belongsToStagePayload(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isPropertyAssignment(parent) &&
      ['stage', 'stages', 'stageInsert'].includes(propertyName(parent) ?? '')
    )
      return true
    if (ts.isVariableDeclaration(parent) || ts.isReturnStatement(parent)) return false
  }
  return false
}

/** Find cursor-stage owner writes that bypass the one owner-policy decision. */
export function unguardedWorkflowCursorOwnerWrites(root = ROOT): string[] {
  const findings: string[] = []
  for (const path of sourceFiles(
    root,
    ['orchestrator/src/workflow'],
    (candidate) => candidate.endsWith('.ts') && !candidate.endsWith('.test.ts'),
  )) {
    const source = readFileSync(`${root}/${path}`, 'utf8')
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node) === 'sessionId' &&
        belongsToStagePayload(node) &&
        !(
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'cursorOwnerAfter'
        )
      ) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        findings.push(`${path}:${line}: route stage sessionId through cursorOwnerAfter`)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

if (import.meta.main) {
  const findings = [...bareWorkflowCursorHandles(), ...unguardedWorkflowCursorOwnerWrites()]
  for (const finding of findings) console.error(finding)
  if (findings.length) process.exit(1)
  console.log('check-workflow-cursor-handles: ok')
}
