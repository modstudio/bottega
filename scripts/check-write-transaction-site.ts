import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
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
collect(join(root, 'hub', 'src'))

const violations: string[] = []
for (const path of files) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
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
        violations.push(`${relative(root, path)}:${line}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

if (violations.length) {
  for (const violation of violations)
    console.error(
      violation.startsWith('hub/')
        ? `${violation}: only hub/src/db.ts:writeTransaction may open a production transaction`
        : `${violation}: only orchestrator/src/db.ts:writeTransaction may open a production transaction`,
    )
  process.exit(1)
}
