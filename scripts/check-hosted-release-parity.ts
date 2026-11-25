#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PRODUCTION_ROOTS = ['orchestrator/src', 'hub/src'] as const

type SourceFile = { path: string; text: string }

function localReleaseGates(file: SourceFile): { name: string; line: number }[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
  const gates: { name: string; line: number }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const inspectCondition = (condition: ts.Node): void => {
        const name =
          (ts.isIdentifier(condition) && condition.text) ||
          (ts.isPropertyAccessExpression(condition) && condition.name.text)
        if (name?.match(/^releaseLocal[A-Z]/)) {
          const { line } = source.getLineAndCharacterOfPosition(condition.getStart(source))
          gates.push({ name, line: line + 1 })
        }
        ts.forEachChild(condition, inspectCondition)
      }
      inspectCondition(node.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return gates
}

function hasHostedReleaseCall(text: string, hostedName: string, path: string): boolean {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === hostedName) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === hostedName))
    )
      found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

export function hostedReleaseParityViolations(files: SourceFile[]): string[] {
  return files.flatMap((file) => {
    if (file.path.endsWith('.test.ts')) return []
    return localReleaseGates(file).flatMap(({ name, line }) => {
      const hostedName = name.replace(/^releaseLocal/, 'releaseHosted')
      if (hasHostedReleaseCall(file.text, hostedName, file.path)) return []
      return [
        `${file.path}:${line}: ${name} gate has no ${hostedName}( call; add a ${hostedName}( call beside the ${name} gate, or rename the gate if it releases nothing hosted`,
      ]
    })
  })
}

export function run(): number {
  const startedAt = performance.now()
  const files = PRODUCTION_ROOTS.flatMap((sourceRoot) =>
    [...new Bun.Glob('**/*.ts').scanSync({ cwd: join(ROOT, sourceRoot), onlyFiles: true })].map(
      (relative) => ({
        path: `${sourceRoot}/${relative}`,
        text: readFileSync(join(ROOT, sourceRoot, relative), 'utf8'),
      }),
    ),
  )
  const violations = hostedReleaseParityViolations(files)
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) return 1
  console.log(
    `check-hosted-release-parity: ok (${files.length} production TypeScript files; ${(performance.now() - startedAt).toFixed(1)}ms)`,
  )
  return 0
}

if (import.meta.main) process.exit(run())
