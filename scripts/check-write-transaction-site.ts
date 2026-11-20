import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const started = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const files: string[] = []
const migrationStepHandleModules = new Set([
  'orchestrator/src/database/database-commands.ts',
  'orchestrator/src/database/hosted-row-release.ts',
  'orchestrator/src/database/machine-update.ts',
  'orchestrator/src/database/release-update.ts',
  'orchestrator/src/record/record-auth-command.ts',
])
const migrationStepHandles = new Set([
  'withDatabaseForMigrationStep',
  'withSynchronousDatabaseForMigrationStep',
])

function collect(directory: string) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      files.push(path)
  }
}

collect(join(root, 'orchestrator', 'src'))
collect(join(root, 'shared'))
collect(join(root, 'hub', 'src'))

const violations: string[] = []
for (const path of files) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const repositoryPath = relative(root, path)
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === './db.ts' ||
        node.moduleSpecifier.text.endsWith('/database/db.ts')) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      !migrationStepHandleModules.has(repositoryPath)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        if (!migrationStepHandles.has(imported)) continue
        const line = file.getLineAndCharacterOfPosition(element.getStart(file)).line + 1
        violations.push(
          `${repositoryPath}:${line}: ${imported} is reserved for named store-maintenance modules`,
        )
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction'
    ) {
      let parent: ts.Node | undefined = node
      let sanctioned = false
      while (parent) {
        if (
          ts.isFunctionDeclaration(parent) &&
          parent.name?.text === 'writeTransaction' &&
          basename(path) === 'db.ts'
        ) {
          sanctioned = true
          break
        }
        parent = parent.parent
      }
      if (!sanctioned) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        violations.push(`${repositoryPath}:${line}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

if (violations.length) {
  for (const violation of violations) {
    console.error(
      violation.includes(' is reserved ')
        ? violation
        : violation.startsWith('hub/')
          ? `${violation}: only hub/src/db.ts:writeTransaction may open a production transaction`
          : `${violation}: only orchestrator/src/database/db.ts:writeTransaction may open a production transaction`,
    )
  }
  process.exit(1)
}

console.log(`database write-site scan: ${(performance.now() - started).toFixed(1)}ms`)
