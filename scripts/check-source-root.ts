/** Refuse source-checkout roots as runtime inputs in code compiled into the binary. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { PLATFORM_NAME } from '../shared/brand.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

export type SourceRootAllowance = { path: string; line: number; reason: string }

/** Checkout-root uses that are unreachable or explicitly guarded in an installed binary. */
export const SOURCE_ROOT_ALLOWANCES: SourceRootAllowance[] = [
  {
    path: 'orchestrator/src/canon/canon.ts',
    line: 16,
    reason: 'repository citation validation runs only against canon maintained in a checkout',
  },
  {
    path: 'orchestrator/src/database/database-location.ts',
    line: 30,
    reason: 'defines the empty installed source root used by explicit embedded-manifest branches',
  },
  {
    path: 'orchestrator/src/database/store-write-lock.ts',
    line: 35,
    reason: 'the optional Darwin diagnostic reports unsupported when checkout source is absent',
  },
  {
    path: 'orchestrator/src/resources/ref-guard-runtime.ts',
    line: 29,
    reason: 'the tracked hook path is selected only when no embedded manifest exists',
  },
  {
    path: 'orchestrator/src/sandbox/sandbox-runtime.ts',
    line: 24,
    reason: 'source availability checks node_modules only when no embedded manifest exists',
  },
  {
    path: 'orchestrator/src/sandbox/sandbox-runtime.ts',
    line: 56,
    reason: 'installed payload resolution selects embedded files instead of this disk fallback',
  },
  {
    path: 'orchestrator/src/sandbox/sandbox.ts',
    line: 224,
    reason: 'the source-root sandbox carveout is explicitly omitted for embedded distributions',
  },
  {
    path: 'orchestrator/src/transport/transport.ts',
    line: 375,
    reason: 'the checkout codex-acp candidate is guarded by the embedded-manifest branch',
  },
  {
    path: 'orchestrator/src/transport/transport.ts',
    line: 431,
    reason:
      'ACP SDK presence is resolved for doctor; the SDK is imported by the ACP transport, not loaded as the compiled schema validator',
  },
  {
    path: 'hub/src/cli-program.ts',
    line: 254,
    reason: 'task import is a source-checkout maintenance command and needs its registered project',
  },
  {
    path: 'hub/src/cli-program.ts',
    line: 268,
    reason: 'task import reads checkout git history only in that source maintenance command',
  },
  {
    path: 'hub/src/db.ts',
    line: 52,
    reason: 'embedded hub runtime resolution skips checkout discovery and legacy paths',
  },
  {
    path: 'hub/src/hosted.ts',
    line: 56,
    reason: 'the hosted deployment entry serves its separately built checkout web bundle',
  },
  {
    path: 'hub/src/hosted.ts',
    line: 63,
    reason: 'the hosted deployment entry serves its separately built checkout web bundle',
  },
]

function isSourceRootModule(value: string): boolean {
  return /^(?:\.\.?\/)+.*database\/(?:db|database-location)\.ts$/.test(value)
}

function isPackageSpecifier(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('.') &&
    !value.startsWith('/') &&
    !value.startsWith('node:')
  )
}

function isImportMetaUrl(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  )
}

function isLocalSourceRootInitializer(node: ts.Expression | undefined): boolean {
  if (
    !node ||
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'fileURLToPath' ||
    node.arguments.length !== 1
  ) {
    return false
  }
  const url = node.arguments[0]
  return (
    ts.isNewExpression(url) &&
    ts.isIdentifier(url.expression) &&
    url.expression.text === 'URL' &&
    url.arguments?.length === 2 &&
    isImportMetaUrl(url.arguments[1]!)
  )
}

function isDirectCheckoutUrl(node: ts.Expression): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'fileURLToPath' &&
    node.arguments.length === 1
  ) {
    const argument = node.arguments[0]!
    return isImportMetaUrl(argument) || isDirectCheckoutUrl(argument)
  }
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL' &&
    node.arguments?.length === 2 &&
    isImportMetaUrl(node.arguments[1]!)
  )
}

type Binding =
  | ts.VariableDeclaration
  | ts.ParameterDeclaration
  | ts.ImportSpecifier
  | ts.NamespaceImport
type Scope = ts.SourceFile | ts.Block | ts.FunctionLikeDeclaration

function isScope(node: ts.Node): node is Scope {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
}

function declarationScope(node: Binding): Scope | undefined {
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return node.getSourceFile()
  if (ts.isParameter(node)) return ts.isFunctionLike(node.parent) ? node.parent : undefined
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isScope(current)) return current
    current = current.parent
  }
  return undefined
}

type BindingFacts = {
  bindings: Map<Scope, Map<string, Binding>>
  direct: Set<Binding>
  namespaces: Set<Binding>
}

function bind(facts: BindingFacts, scope: Scope, name: string, declaration: Binding): void {
  const names = facts.bindings.get(scope) ?? new Map<string, Binding>()
  names.set(name, declaration)
  facts.bindings.set(scope, names)
}

function gatherLexicalBinding(node: ts.Node, facts: BindingFacts): void {
  if (!(ts.isVariableDeclaration(node) || ts.isParameter(node)) || !ts.isIdentifier(node.name)) {
    return
  }
  const scope = declarationScope(node)
  if (scope) bind(facts, scope, node.name.text, node)
  if (ts.isVariableDeclaration(node) && isLocalSourceRootInitializer(node.initializer)) {
    facts.direct.add(node)
  }
}

function gatherSourceRootImport(node: ts.Node, source: ts.SourceFile, facts: BindingFacts): void {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    !isSourceRootModule(node.moduleSpecifier.text)
  ) {
    return
  }
  const imports = node.importClause?.namedBindings
  if (imports && ts.isNamedImports(imports)) {
    for (const element of imports.elements) {
      bind(facts, source, element.name.text, element)
      if ((element.propertyName ?? element.name).text === 'ROOT') facts.direct.add(element)
    }
  } else if (imports && ts.isNamespaceImport(imports)) {
    bind(facts, source, imports.name.text, imports)
    facts.namespaces.add(imports)
  }
}

function gatherBindings(node: ts.Node, source: ts.SourceFile, facts: BindingFacts): void {
  gatherLexicalBinding(node, facts)
  gatherSourceRootImport(node, source, facts)
  ts.forEachChild(node, (child) => gatherBindings(child, source, facts))
}

function bindingFor(
  identifier: ts.Identifier,
  bindings: Map<Scope, Map<string, Binding>>,
): Binding | undefined {
  let current: ts.Node | undefined = identifier.parent
  while (current) {
    if (isScope(current)) {
      const binding = bindings.get(current)?.get(identifier.text)
      if (binding) return binding
    }
    current = current.parent
  }
  return undefined
}

function gatherCreateRequireNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      (statement.moduleSpecifier.text !== 'node:module' &&
        statement.moduleSpecifier.text !== 'module')
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'createRequire') {
        names.add(element.name.text)
      }
    }
  }
  return names
}

function isCreateRequireImportMetaUrl(
  node: ts.Expression,
  createRequireNames: Set<string>,
): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    createRequireNames.has(node.expression.text) &&
    node.arguments.length === 1 &&
    isImportMetaUrl(node.arguments[0]!)
  )
}

function gatherModuleRelativeRequireNames(
  node: ts.Node,
  createRequireNames: Set<string>,
  requireNames: Set<string>,
): void {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    isCreateRequireImportMetaUrl(node.initializer, createRequireNames)
  ) {
    requireNames.add(node.name.text)
  }
  ts.forEachChild(node, (child) =>
    gatherModuleRelativeRequireNames(child, createRequireNames, requireNames),
  )
}

function identifierIsRequire(identifier: ts.Identifier, requireNames: Set<string>): boolean {
  return requireNames.has(identifier.text)
}

function packageRequireArgument(node: ts.CallExpression): ts.Expression | undefined {
  if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) return undefined
  return isPackageSpecifier(node.arguments[0].text) ? node.arguments[0] : undefined
}

function moduleRelativePackageRequireNode(
  node: ts.Node,
  createRequireNames: Set<string>,
  requireNames: Set<string>,
): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const argument = packageRequireArgument(node)
  if (!argument) return undefined
  if (isCreateRequireImportMetaUrl(node.expression, createRequireNames)) return argument
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'resolve' &&
    isCreateRequireImportMetaUrl(node.expression.expression, createRequireNames)
  ) {
    return argument
  }
  if (ts.isIdentifier(node.expression) && identifierIsRequire(node.expression, requireNames)) {
    return argument
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'resolve' &&
    ts.isIdentifier(node.expression.expression) &&
    identifierIsRequire(node.expression.expression, requireNames)
  ) {
    return argument
  }
  return undefined
}

/** Return one-based lines that use a checkout source root as a runtime input. */
export function sourceRootViolationLines(
  sourceText: string,
  path: string,
  allowances: SourceRootAllowance[] = SOURCE_ROOT_ALLOWANCES,
): number[] {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const facts: BindingFacts = {
    bindings: new Map(),
    direct: new Set(),
    namespaces: new Set(),
  }
  gatherBindings(source, source, facts)
  const createRequireNames = gatherCreateRequireNames(source)
  const requireNames = new Set<string>()
  gatherModuleRelativeRequireNames(source, createRequireNames, requireNames)
  const violations = new Set<number>()
  const allowed = new Set(
    allowances.filter((allowance) => allowance.path === path).map((allowance) => allowance.line),
  )
  const report = (node: ts.Node): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    if (!allowed.has(line)) violations.add(line)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      facts.direct.has(bindingFor(node, facts.bindings)!) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    ) {
      report(node)
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      facts.namespaces.has(bindingFor(node.expression, facts.bindings)!) &&
      node.name.text === 'ROOT'
    ) {
      report(node)
      return
    }
    const packageRequire = moduleRelativePackageRequireNode(node, createRequireNames, requireNames)
    if (packageRequire) {
      report(packageRequire)
      return
    }
    if (
      ts.isExpression(node) &&
      isDirectCheckoutUrl(node) &&
      !(
        ts.isVariableDeclaration(node.parent) &&
        node.parent.initializer === node &&
        ts.isVariableDeclarationList(node.parent.parent) &&
        ts.isVariableStatement(node.parent.parent.parent) &&
        !node.parent.parent.parent.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) &&
      !(
        ts.isNewExpression(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        isDirectCheckoutUrl(node.parent)
      )
    ) {
      report(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...violations].sort((a, b) => a - b)
}

function collect(directory: string, files: string[]): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path, files)
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixtures.ts')
    ) {
      files.push(path)
    }
  }
}

if (import.meta.main) {
  const files: string[] = []
  for (const directory of ['orchestrator/src', 'hub/src', 'retrieval/src', 'shared']) {
    collect(join(root, directory), files)
  }
  const violations = files.flatMap((path) => {
    const repositoryPath = relative(root, path)
    return sourceRootViolationLines(readFileSync(path, 'utf8'), repositoryPath).map(
      (line) => `${repositoryPath}:${line}`,
    )
  })
  for (const violation of violations) {
    console.error(
      `${violation}: ${PLATFORM_NAME} binary runtime behavior must not depend on its source-checkout root`,
    )
  }
  if (violations.length) process.exit(1)
}
