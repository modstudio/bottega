#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HELPER = 'orchestrator/src/resources/docker-inventory-command.ts'
const DOCKER_RESOURCES = 'orchestrator/src/resources/docker-resources.ts'
const SPAWN_NAMES = new Set([
  'spawn',
  'spawnSync',
  'startBounded',
  'startBoundedSync',
  'execa',
  'execaSync',
])

function stringElements(node: ts.Expression | undefined): string[] | null {
  if (!node || !ts.isArrayLiteralExpression(node)) return null
  const values: string[] = []
  for (const element of node.elements) {
    if (!ts.isStringLiteral(element)) return null
    values.push(element.text)
  }
  return values
}

function isInventoryCommand(values: readonly string[]): boolean {
  if (values[0] !== 'docker') return false
  if (values[1] === 'ps') return true
  return (
    (values[1] === 'volume' && values[2] === 'ls') ||
    (values[1] === 'network' && values[2] === 'ls')
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
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'executableAbsentFrom' &&
          ts.isIdentifier(node.arguments[0]) &&
          node.arguments[0].text === variable.text
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

function approvedBoundedNetworkList(
  call: ts.CallExpression,
  command: readonly string[],
  fileName: string,
): boolean {
  return (
    fileName === DOCKER_RESOURCES &&
    spawnName(call) === 'startBoundedSync' &&
    command[0] === 'docker' &&
    command[1] === 'network' &&
    command[2] === 'ls' &&
    dockerBudget(call.arguments[1]) &&
    catchUsesSharedClassifier(call)
  )
}

export function dockerInventorySpawnBypasses(source: string, fileName: string): string[] {
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
        !approvedBoundedNetworkList(node, command, fileName)
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
  const patterns = ['orchestrator/src/resources/**/*.ts', 'orchestrator/src/cleanup/**/*.ts']
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
