import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'

const root = new URL('..', import.meta.url).pathname
const files: string[] = []

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

const violations: string[] = []
for (const path of files) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Bun' &&
      (node.expression.name.text === 'spawn' || node.expression.name.text === 'spawnSync') &&
      ts.isArrayLiteralExpression(node.arguments[0]!) &&
      ts.isStringLiteral(node.arguments[0]!.elements[0]!) &&
      node.arguments[0]!.elements[0]!.text === 'git'
    ) {
      const options = node.arguments[1]
      const env =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property) =>
                (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
                property.name.getText(file) === 'env',
            )
          : undefined
      const raw =
        env && ts.isPropertyAssignment(env) && env.initializer.getText(file).includes('process.env')
      if (!env || raw) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        violations.push(`${relative(root, path)}:${line}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

if (violations.length) {
  for (const violation of violations)
    console.error(`${violation}: production git spawn must supply a scrubbed environment`)
  process.exit(1)
}
