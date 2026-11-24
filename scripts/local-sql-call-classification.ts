import ts from 'typescript'

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let value = expression
  while (
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isParenthesizedExpression(value)
  )
    value = value.expression
  return value
}

export function sqlCallArgument(node: ts.Node, methods: ReadonlySet<string>): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null
  const target = unwrapExpression(node.expression)
  const method = ts.isIdentifier(target)
    ? target.text
    : ts.isPropertyAccessExpression(target)
      ? target.name.text
      : null
  const argument = node.arguments[0]
  return method && methods.has(method) && argument ? argument : null
}

export function couldBeSqlExpression(expression: ts.Expression, statementStart: RegExp): boolean {
  const value = unwrapExpression(expression)
  if (ts.isIdentifier(value)) return /(?:sql|query|statement)/i.test(value.text)
  if (ts.isPropertyAccessExpression(value)) return /(?:sql|query|statement)/i.test(value.name.text)
  if (ts.isElementAccessExpression(value))
    return /(?:sql|query|statement)/i.test(value.expression.getText())
  if (ts.isTemplateExpression(value)) return statementStart.test(value.head.text)
  if (ts.isBinaryExpression(value)) return couldBeSqlExpression(value.left, statementStart)
  if (ts.isCallExpression(value)) return /(?:sql|query|statement)/i.test(value.expression.getText())
  return false
}

export function renderedSqlRiskCandidates(
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const visit = (node: ts.Node): void => {
    const value = ts.isExpression(node) ? unwrapExpression(node) : node
    if (ts.isStringLiteralLike(value)) {
      candidates.push(value.text)
      return
    }
    if (ts.isTemplateExpression(value))
      candidates.push(
        `${value.head.text}${value.templateSpans.map((span) => span.literal.text).join('')}`,
      )
    if (ts.isIdentifier(value)) {
      if (seen.has(value.text)) return
      const initializer = constants.get(value.text)
      if (initializer) {
        seen.add(value.text)
        visit(initializer)
      }
      return
    }
    ts.forEachChild(value, visit)
  }
  visit(expression)
  return candidates
}

export type RenderedSqlCallArgument = {
  statements: string[]
  unresolved: ts.Expression | null
  unresolvedSql: boolean
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === ';') {
      statements.push(sql.slice(start, index))
      start = index + 1
    }
  }
  statements.push(sql.slice(start))
  return statements.map((statement) => statement.trim()).filter(Boolean)
}

function interpolationIsScalar(sql: string): boolean {
  if (/(?:=|<>|\bIN\s*\()\s*$/i.test(sql)) return true
  const statement = splitSqlStatements(sql).at(-1) ?? ''
  const valuesAt = statement.search(/\bVALUES\b/i)
  if (valuesAt < 0) return false
  let depth = 0
  let quote: "'" | '"' | null = null
  for (const character of statement.slice(valuesAt + 'VALUES'.length)) {
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
  }
  return depth > 0 && /(?:\(|,)\s*$/.test(statement)
}

function appendSpan(
  sql: string,
  span: ts.TemplateSpan,
): { sql: string; unresolved: ts.Expression | null } {
  const value = unwrapExpression(span.expression)
  if (ts.isIdentifier(value) && value.text === 'statement') return { sql, unresolved: value }
  let suffix = span.literal.text
  const exactlySingleQuoted = sql.endsWith("'") && suffix.startsWith("'")
  if (exactlySingleQuoted) {
    sql = sql.slice(0, -1)
    suffix = suffix.slice(1)
  }
  const singleQuoted = !exactlySingleQuoted && (sql.match(/'/g)?.length ?? 0) % 2 === 1
  const quotedLiteral = exactlySingleQuoted || singleQuoted
  const stringProducingConditional =
    ts.isConditionalExpression(value) &&
    [value.whenTrue, value.whenFalse].some(
      (branch) =>
        ts.isStringLiteralLike(unwrapExpression(branch)) ||
        ts.isTemplateLiteral(unwrapExpression(branch)),
    )
  if (!quotedLiteral && (!interpolationIsScalar(sql) || stringProducingConditional))
    return { sql, unresolved: value }
  return { sql: `${sql}NULL${suffix}`, unresolved: null }
}

export function renderSqlCallArgument(
  expression: ts.Expression,
  statementStart: RegExp,
): RenderedSqlCallArgument | null {
  const node = unwrapExpression(expression)
  if (ts.isStringLiteralLike(node))
    return {
      statements: splitSqlStatements(node.text),
      unresolved: null,
      unresolvedSql: false,
    }
  if (!ts.isTemplateExpression(node)) return null
  let sql = node.head.text
  for (const span of node.templateSpans) {
    const appended = appendSpan(sql, span)
    if (appended.unresolved)
      return {
        statements: [],
        unresolved: appended.unresolved,
        unresolvedSql: splitSqlStatements(sql).some((statement) => statementStart.test(statement)),
      }
    sql = appended.sql
  }
  return {
    statements: splitSqlStatements(sql),
    unresolved: null,
    unresolvedSql: false,
  }
}
