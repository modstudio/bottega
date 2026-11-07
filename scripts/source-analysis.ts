import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as ts from 'typescript'

export function sourceFiles(
  root: string,
  sourceRoots: readonly string[],
  include: (path: string) => boolean,
): string[] {
  const files: string[] = []
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) collect(absolute)
      else if (entry.isFile()) files.push(relative(root, absolute))
    }
  }
  for (const sourceRoot of sourceRoots) {
    const source = resolve(root, sourceRoot)
    if (existsSync(source)) collect(source)
  }
  return files.filter(include).sort()
}

export function enclosingFunctionName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
  }
  return null
}
