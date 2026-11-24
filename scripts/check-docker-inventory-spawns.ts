#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HELPER = 'orchestrator/src/resources/docker-inventory-command.ts'
const SPAWN_NAMES = new Set([
  'spawn',
  'spawnSync',
  'startBounded',
  'startBoundedSync',
  'execa',
  'execaSync',
])

function enclosingScopes(node: ts.Node): (ts.Block | ts.SourceFile)[] {
  const scopes: (ts.Block | ts.SourceFile)[] = []
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) scopes.push(parent)
  }
  return scopes
}

function constArrayInScope(
  scope: ts.Block | ts.SourceFile,
  identifier: ts.Identifier,
): ts.ArrayLiteralExpression | null {
  const declarations = scope.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? [...statement.declarationList.declarations]
      : [],
  )
  for (const declaration of declarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === identifier.text &&
      declaration.pos < identifier.pos &&
      declaration.initializer &&
      ts.isArrayLiteralExpression(declaration.initializer)
    ) {
      return declaration.initializer
    }
  }
  return null
}

function constArrayInitializer(identifier: ts.Identifier): ts.ArrayLiteralExpression | null {
  for (const scope of enclosingScopes(identifier)) {
    const initializer = constArrayInScope(scope, identifier)
    if (initializer) return initializer
  }
  return null
}

function stringElements(node: ts.Expression | undefined): string[] | null {
  if (node && ts.isIdentifier(node)) node = constArrayInitializer(node) ?? node
  if (!node || !ts.isArrayLiteralExpression(node)) return null
  const values: string[] = []
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) return null
    values.push(element.text)
  }
  return values
}

function isInventoryCommand(values: readonly string[]): boolean {
  if (values[0] !== 'docker') return false
  if (values[1] === 'ps') return true
  return (
    (values[1] === 'volume' && (values[2] === 'ls' || values[2] === 'inspect')) ||
    (values[1] === 'network' && (values[2] === 'ls' || values[2] === 'inspect'))
  )
}

function spawnName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text
  return null
}

function dockerBudget(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options)) return false
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'budget' &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === 'docker',
  )
}

function catchUsesSharedClassifier(call: ts.CallExpression): boolean {
  let parent: ts.Node | undefined = call.parent
  while (parent) {
    if (
      ts.isTryStatement(parent) &&
      parent.tryBlock.pos <= call.pos &&
      call.end <= parent.tryBlock.end
    ) {
      const variable = parent.catchClause?.variableDeclaration?.name
      if (!variable || !ts.isIdentifier(variable)) return false
      let classified = false
      const visit = (node: ts.Node): void => {
        const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'classifyDockerInventorySpawnError' &&
          argument &&
          ts.isIdentifier(argument) &&
          argument.text === variable.text
        ) {
          classified = true
        }
        ts.forEachChild(node, visit)
      }
      if (parent.catchClause) visit(parent.catchClause.block)
      return classified
    }
    parent = parent.parent
  }
  return false
}

function approvedBoundedInventory(call: ts.CallExpression): boolean {
  return (
    spawnName(call) === 'startBoundedSync' &&
    dockerBudget(call.arguments[1]) &&
    catchUsesSharedClassifier(call)
  )
}

export function dockerInventorySpawnBypasses(source: string, fileName: string): string[] {
  if (!source.includes("'docker'") && !source.includes('"docker"') && !source.includes('`docker`'))
    return []
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const failures: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = spawnName(node)
      const command = stringElements(node.arguments[0])
      if (
        name &&
        SPAWN_NAMES.has(name) &&
        command &&
        isInventoryCommand(command) &&
        !approvedBoundedInventory(node)
      ) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        failures.push(
          `${fileName}:${line}: Docker inventory spawns must use runDockerInventoryCommand`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return failures
}

function sourceFiles(): string[] {
  const patterns = ['orchestrator/src/**/*.ts']
  return patterns.flatMap((pattern) =>
    [...new Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })].filter(
      (path) => !path.endsWith('.test.ts') && path !== HELPER,
    ),
  )
}

if (import.meta.main) {
  const failures = sourceFiles().flatMap((path) =>
    dockerInventorySpawnBypasses(readFileSync(`${ROOT}/${path}`, 'utf8'), path),
  )
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}
