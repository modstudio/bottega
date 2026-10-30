#!/usr/bin/env bun
/** Refuse production Bun servers that rely on Bun's changing default idle timeout. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const SOURCE_ROOTS = ['hub/src', 'orchestrator/src', 'shared']
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const TEST_FILE = /(?:^|\/)\S+\.test\.[cm]?[jt]sx?$/

/** Return one-based lines of Bun.serve object literals that omit idleTimeout. */
export function bunServeTimeoutViolationLines(sourceText: string, path: string): number[] {
  if (TEST_FILE.test(path.replaceAll('\\', '/'))) return []
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const violations: number[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Bun' &&
      node.expression.name.text === 'serve'
    ) {
      const options = node.arguments[0]
      if (options && ts.isObjectLiteralExpression(options)) {
        const namesIdleTimeout = options.properties.some(
          (property) =>
            (ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property) ||
              ts.isMethodDeclaration(property) ||
              ts.isGetAccessorDeclaration(property) ||
              ts.isSetAccessorDeclaration(property)) &&
            property.name !== undefined &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === 'idleTimeout',
        )
        if (!namesIdleTimeout) {
          violations.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && SOURCE_FILE.test(entry.name) ? [path] : []
  })
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const violations = SOURCE_ROOTS.flatMap((directory) =>
    sourceFiles(join(root, directory)).flatMap((absolute) => {
      const path = relative(root, absolute)
      return bunServeTimeoutViolationLines(readFileSync(absolute, 'utf8'), path).map(
        (line) => `${path}:${line}: Bun.serve options must name idleTimeout`,
      )
    }),
  )
  if (violations.length) {
    console.error(`Bun.serve timeout check failed\n${violations.join('\n')}`)
    process.exit(1)
  }
  console.log('Bun.serve timeout check passed')
}
