#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

const SIDE_CHANNELS = [
  {
    file: 'orchestrator/src/board/board-delivery.ts',
    functions: ['claimRunBoardNotices'],
  },
  {
    file: 'orchestrator/src/board/board-push-service.ts',
    functions: ['refreshForPendingBoardDelivery', 'pendingBoardDelivery'],
  },
  {
    file: 'orchestrator/src/board/board-service.ts',
    functions: ['boardRequestCountForSession'],
  },
] as const

export type BoardSideChannelRefreshViolation = {
  file: string
  functionName: string
  line: number
}

export function boardSideChannelRefreshViolations(
  sourceText: string,
  file: string,
  expectedFunctions: readonly string[],
): BoardSideChannelRefreshViolation[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const expected = new Set(expectedFunctions)
  const found = new Set<string>()
  const violations: BoardSideChannelRefreshViolation[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const name = node.name.text
      if (expected.has(name)) {
        found.add(name)
        const inspect = (child: ts.Node): void => {
          if (ts.isThrowStatement(child)) {
            const { line } = source.getLineAndCharacterOfPosition(child.getStart(source))
            violations.push({ file, functionName: name, line: line + 1 })
          }
          ts.forEachChild(child, inspect)
        }
        inspect(node.body)
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  for (const name of expected)
    if (!found.has(name)) violations.push({ file, functionName: name, line: 1 })
  return violations
}

function run(): number {
  const startedAt = performance.now()
  const violations = SIDE_CHANNELS.flatMap(({ file, functions }) =>
    boardSideChannelRefreshViolations(readFileSync(join(ROOT, file), 'utf8'), file, functions),
  )
  for (const violation of violations)
    console.error(
      `${violation.file}:${violation.line}: ${violation.functionName} is a board side channel; return a warning on a non-success refresh and never throw`,
    )
  if (violations.length) return 1
  console.log(
    `check-board-side-channel-refresh: ok (${SIDE_CHANNELS.flatMap(({ functions }) => functions).join(', ')}; ${(performance.now() - startedAt).toFixed(1)}ms)`,
  )
  return 0
}

if (import.meta.main) process.exit(run())
