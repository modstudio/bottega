import ts from 'typescript'

export type ImportScan = {
  specifiers: string[]
  typeOnlySpecifiers: string[]
  unresolvedRelative: string[]
}

function staticString(
  node: ts.Expression,
  constants: Map<string, ts.Expression>,
  seen = new Set<string>(),
): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
    return staticString(constants.get(node.text)!, constants, new Set(seen).add(node.text))
  }
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression, constants, seen)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, constants, seen)
    const right = staticString(node.right, constants, seen)
    return left === null || right === null ? null : left + right
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression, constants, seen)
      if (expression === null) return null
      value += expression + span.literal.text
    }
    return value
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'resolve' &&
    ts.isMetaProperty(node.expression.expression) &&
    node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1
  ) {
    return staticString(node.arguments[0]!, constants, seen)
  }
  return null
}

function beginsRelative(node: ts.Expression, constants: Map<string, ts.Expression>): boolean {
  const value = staticString(node, constants)
  if (value !== null) return value.startsWith('.')
  if (ts.isParenthesizedExpression(node)) return beginsRelative(node.expression, constants)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return beginsRelative(node.left, constants)
  }
  if (ts.isTemplateExpression(node)) return node.head.text.startsWith('.')
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'resolve' &&
    ts.isMetaProperty(node.expression.expression) &&
    node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1
  ) {
    return beginsRelative(node.arguments[0]!, constants)
  }
  return false
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${line + 1}:${character + 1} ${node.getText(sourceFile)}`
}

/** Resolve statically knowable module specifiers and expose unresolved relative calls. */
export function importSpecifiers(source: string): ImportScan {
  const sourceFile = ts.createSourceFile(
    'source.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const specifiers: string[] = []
  const typeOnlySpecifiers: string[] = []
  const unresolvedRelative: string[] = []
  const createRequireNames = new Set(['createRequire'])
  const requireNames = new Set(['require'])
  const constants = new Map<string, ts.Expression>()

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'node:module'
    ) {
      const bindings = statement.importClause?.namedBindings
      for (const element of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
        if ((element.propertyName ?? element.name).text === 'createRequire') {
          createRequireNames.add(element.name.text)
        }
      }
    }
  }

  function collectCreateRequireAliases(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      createRequireNames.has(node.initializer.expression.text)
    ) {
      requireNames.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constants.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collectCreateRequireAliases)
  }
  collectCreateRequireAliases(sourceFile)

  function record(argument: ts.Expression, call: ts.Node): void {
    const specifier = staticString(argument, constants)
    if (specifier !== null) specifiers.push(specifier)
    else if (beginsRelative(argument, constants))
      unresolvedRelative.push(location(sourceFile, call))
  }

  function recordDeclaration(node: ts.ImportDeclaration | ts.ExportDeclaration): void {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return
    const typeOnly = ts.isImportDeclaration(node)
      ? node.importClause?.isTypeOnly === true
      : node.isTypeOnly
    ;(typeOnly ? typeOnlySpecifiers : specifiers).push(node.moduleSpecifier.text)
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordDeclaration(node)
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node.arguments[0]!, node)
      } else if (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) {
        record(node.arguments[0]!, node)
      } else if (
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        createRequireNames.has(node.expression.expression.text)
      ) {
        record(node.arguments[0]!, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { specifiers, typeOnlySpecifiers, unresolvedRelative }
}
