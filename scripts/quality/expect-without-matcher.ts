import type { Rule } from 'eslint'

export const expectWithoutMatcherRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      matcherMissing: 'Expect must have a corresponding matcher call.',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const expression = node.expression
        if (
          expression.type !== 'CallExpression' ||
          expression.callee.type !== 'Identifier' ||
          expression.callee.name !== 'expect'
        )
          return
        context.report({ node: expression, messageId: 'matcherMissing' })
      },
    }
  },
}
