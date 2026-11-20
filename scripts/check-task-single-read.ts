#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

export type TaskSingleReadViolation = { file: string; line: number }

/** Refuse resolving one task key from a task-list read in the same function. */
export function taskSingleReadViolations(source: string, file: string): TaskSingleReadViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: TaskSingleReadViolation[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      const text = node.getText(sourceFile)
      const readsList = /taskReader\(\)\.list\s*\(|readHubTasks\s*\(/.test(text)
      const searchesKey = /\.find\s*\([\s\S]*?\.(?:key|record_id)\s*===/.test(text)
      if (readsList && searchesKey) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push({ file, line: line + 1 })
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function run(): number {
  const violations: TaskSingleReadViolation[] = []
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, 'orchestrator/src') })) {
    if (relative.endsWith('.test.ts')) continue
    const file = `orchestrator/src/${relative}`
    violations.push(...taskSingleReadViolations(readFileSync(join(ROOT, file), 'utf8'), file))
  }
  for (const violation of violations)
    console.error(
      `${violation.file}:${violation.line}: resolve one task through taskReader().show(key, scope), not a task list`,
    )
  if (violations.length) return 1
  console.log('check-task-single-read: ok')
  return 0
}

if (import.meta.main) process.exit(run())
