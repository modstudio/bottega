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
