import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

export type HostedSqlSite = {
  file: string
  line: number
  sql: string
  fingerprint: string
}

export type HostedSqlUnresolvedSite = HostedSqlSite & { expression: string }

type RenderedSql = { sql: string; bindings: number }
const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i

function hostedSqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return unwrap(node.expression)
  return node
}

function isSqlTag(node: ts.Expression): boolean {
  const tag = unwrap(node)
  return ts.isIdentifier(tag) && (tag.text === 'sql' || tag.text === 'tx')
}

function importsBunSql(source: ts.SourceFile): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'bun' &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (item) => (item.propertyName?.text ?? item.name.text) === 'SQL',
      ),
  )
}

function shiftBindings(sql: string, offset: number): string {
  return sql.replace(/\$(\d+)/g, (_, number: string) => `$${Number(number) + offset}`)
}

function renderFragment(
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
  seen: Set<string>,
): RenderedSql[] | null {
  const node = unwrap(expression)
  if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag))
    return renderTemplate(node.template, constants, seen)
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null
    const initializer = constants.get(node.text)
    if (!initializer) return null
    return renderFragment(initializer, constants, new Set([...seen, node.text]))
  }
  if (ts.isConditionalExpression(node)) {
    const yes = renderFragment(node.whenTrue, constants, seen)
    const no = renderFragment(node.whenFalse, constants, seen)
    return yes && no ? [...yes, ...no] : null
  }
  return null
}

function appendFragments(left: RenderedSql[], right: RenderedSql[]): RenderedSql[] {
  return left.flatMap((prefix) =>
    right.map((suffix) => ({
      sql: prefix.sql + shiftBindings(suffix.sql, prefix.bindings),
      bindings: prefix.bindings + suffix.bindings,
    })),
  )
}

function renderTemplate(
  template: ts.TemplateLiteral,
  constants: Map<string, ts.Expression>,
  seen = new Set<string>(),
): RenderedSql[] | null {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [{ sql: template.text, bindings: 0 }]
  let rendered: RenderedSql[] = [{ sql: template.head.text, bindings: 0 }]
  for (const span of template.templateSpans) {
    const fragment = renderFragment(span.expression, constants, seen)
    if (fragment) rendered = appendFragments(rendered, fragment)
    else {
      const expression = unwrap(span.expression)
      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === 'unsafe'
      )
        return null
      if (ts.isCallExpression(expression) && isSqlTag(expression.expression)) {
        rendered = rendered.map((part) => ({ ...part, sql: `${part.sql}(NULL)` }))
        rendered = rendered.map((part) => ({ ...part, sql: part.sql + span.literal.text }))
        continue
      }
      rendered = rendered.map((part) => ({
        sql: `${part.sql}$${part.bindings + 1}`,
        bindings: part.bindings + 1,
      }))
    }
    rendered = rendered.map((part) => ({ ...part, sql: part.sql + span.literal.text }))
  }
  return rendered
}

function collectConstants(source: ts.SourceFile): Map<string, ts.Expression> {
  const constants = new Map<string, ts.Expression>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const)
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return constants
}

export function extractHostedSqlFromSource(input: { sourceText: string; file: string }): {
  sites: HostedSqlSite[]
  unresolved: HostedSqlUnresolvedSite[]
} {
  const source = ts.createSourceFile(
    input.file,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const constants = collectConstants(source)
  const sites: HostedSqlSite[] = []
  const unresolved: HostedSqlUnresolvedSite[] = []
  if (!importsBunSql(source)) return { sites, unresolved }
  const collectTemplate = (node: ts.TaggedTemplateExpression): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const rendered = renderTemplate(node.template, constants)
    if (rendered) {
      for (const item of rendered) {
        if (!SQL_START.test(item.sql)) continue
        const fingerprint = hostedSqlFingerprint(item.sql)
        sites.push({ file: input.file, line, sql: item.sql, fingerprint })
      }
      return
    }
    const firstText = ts.isNoSubstitutionTemplateLiteral(node.template)
      ? node.template.text
      : node.template.head.text
    if (!SQL_START.test(firstText)) return
    const expression = node.getText(source)
    unresolved.push({
      file: input.file,
      line,
      sql: expression,
      expression,
      fingerprint: hostedSqlFingerprint(expression),
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag)) collectTemplate(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { sites, unresolved }
}

export function extractHostedSql(root: string): {
  sites: HostedSqlSite[]
  unresolved: HostedSqlUnresolvedSite[]
} {
  const sites: HostedSqlSite[] = []
  const unresolved: HostedSqlUnresolvedSite[] = []
  for (const concern of ['orchestrator/src', 'hub/src', 'shared']) {
    for (const file of productionTypeScriptFiles(resolve(root, concern))) {
      const extracted = extractHostedSqlFromSource({
        sourceText: readFileSync(file, 'utf8'),
        file: relative(root, file),
      })
      sites.push(...extracted.sites)
      unresolved.push(...extracted.unresolved)
    }
  }
  return { sites, unresolved }
}
