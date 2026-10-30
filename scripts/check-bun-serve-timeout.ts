#!/usr/bin/env bun
/**
 * Refuse servers that ship with Bun's changing default idle timeout.
 * Release smoke harnesses under scripts/ are deliberately outside this guard.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { isProductionSourceFile } from './architecture-undeclared-modules.ts'

const SOURCE_ROOTS = ['hub/src', 'orchestrator/src', 'shared']
const SOURCE_FILE = /\.[cm]?[jt]sx?$/

/** Return one-based lines of Bun.serve uses that cannot prove an inline idleTimeout. */
export function bunServeTimeoutViolationLines(sourceText: string, path: string): number[] {
  if (!isProductionSourceFile(path.replaceAll('\\', '/')) || !sourceText.includes('Bun.serve')) {
    return []
  }
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
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Bun' &&
      node.name.text === 'serve'
    ) {
      if (ts.isTypeQueryNode(node.parent)) return

      const call =
        ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : undefined
      const options = call?.arguments[0]
      const hasSpread =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.some(ts.isSpreadAssignment)
          : false
      const namesIdleTimeout =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.some(
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
          : false
      if (
        !call ||
        !options ||
        !ts.isObjectLiteralExpression(options) ||
        hasSpread ||
        !namesIdleTimeout
      ) {
        violations.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
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
        (line) => `${path}:${line}: name idleTimeout inline in the Bun.serve options object`,
      )
    }),
  )
  if (violations.length) {
    console.error(`Bun.serve timeout check failed\n${violations.join('\n')}`)
    process.exit(1)
  }
  console.log('Bun.serve timeout check passed')
}
