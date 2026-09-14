import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const rootArgument = process.argv.find((argument) => argument.startsWith('--root='))
const root = resolve(rootArgument?.slice('--root='.length) ?? new URL('..', import.meta.url).pathname)
const orchestrator = resolve(root, 'orchestrator')
const failures: string[] = []

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function productionPath(source: string): boolean {
  return source.startsWith('../src/') || source.startsWith('../../shared/')
}

function importedProductionBindings(source: string): Set<string> {
  const bindings = new Set<string>()
  const imports = source.matchAll(/import\s*{([^}]*)}\s*from\s*['"]([^'"]+)['"]/gs)
  for (const match of imports) {
    if (!productionPath(match[2]!)) continue
    for (const entry of match[1]!.split(',')) {
      const binding = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()
      if (binding) bindings.add(binding)
    }
  }
  return bindings
}

function exportedBindings(source: string): Set<string> {
  const bindings = new Set<string>()
  for (const match of source.matchAll(/export\s*{([^}]*)}(?:\s*from\s*['"]([^'"]+)['"])?/gs)) {
    if (match[2] && productionPath(match[2])) {
      failures.push('re-exports production bindings')
      continue
    }
    for (const entry of match[1]!.split(',')) {
      const binding = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]
      if (binding) bindings.add(binding)
    }
  }
  return bindings
}

function checkFixture(path: string): void {
  if (path.endsWith('/preload.ts') || !path.endsWith('.ts')) return
  const source = readFileSync(path, 'utf8')
  const label = relative(root, path)
  const before = failures.length
  if (/export\s+const\s*{[^}]+}\s*=\s*await\s+import\(\s*['"](?:\.\.\/src\/|\.\.\/\.\.\/shared\/)/s.test(source)) {
    failures.push('re-exports production bindings obtained from await import')
  }
  const imported = importedProductionBindings(source)
  const exported = exportedBindings(source)
  for (const binding of imported) {
    if (exported.has(binding)) failures.push(`re-exports imported production binding ${binding}`)
  }
  for (let index = before; index < failures.length; index += 1) failures[index] = `${label}: ${failures[index]}`
}

function environmentName(node: ts.Node): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  if (!ts.isIdentifier(node.expression.expression)
    || node.expression.expression.text !== 'process'
    || node.expression.name.text !== 'env') return null
  return ['PATH', 'HOME', 'ORCH_SANDBOX'].includes(node.name.text) ? node.name.text : null
}

function checkTest(path: string): void {
  if (!/\.(?:test|spec)\.tsx?$/.test(path)) return
  const source = readFileSync(path, 'utf8')
  const label = relative(root, path)
  for (const statement of ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true).statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && resolve(path, '..', statement.moduleSpecifier.text) === resolve(orchestrator, 'test/fixture.ts')) {
      failures.push(`${label}: imports orchestrator/test/fixture.ts`)
    }
  }
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement)) continue
    const expression = statement.expression
    const assigned = ts.isBinaryExpression(expression)
      && expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && environmentName(expression.left)
    const deleted = ts.isDeleteExpression(expression) && environmentName(expression.expression)
    if (assigned || deleted) {
      const line = ast.getLineAndCharacterOfPosition(statement.getStart(ast)).line + 1
      failures.push(`${label}:${line}: mutates test environment at module top level`)
    }
  }
}

for (const path of filesUnder(resolve(orchestrator, 'test'))) checkFixture(path)
for (const path of filesUnder(orchestrator)) checkTest(path)

if (failures.length) {
  console.error('test fixture boundary failed')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('test fixture boundary passed')
