import type { Rule } from 'eslint'

type Node = Rule.Node & {
  callee?: Node
  expression?: Node
  name?: string
  object?: Node
  property?: Node
}

function containsAsyncModifier(node: Node | undefined): boolean {
  if (!node) return false
  if (
    node.type === 'MemberExpression' &&
    (node.property?.name === 'resolves' || node.property?.name === 'rejects')
  ) {
    return true
  }
  if (node.type === 'CallExpression') return containsAsyncModifier(node.callee)
  if (node.type === 'MemberExpression') return containsAsyncModifier(node.object)
  return false
}

export const vitestAsyncAssertionRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { unhandled: 'This asynchronous assertion must be awaited or returned.' },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const expression = (node as Node).expression
        if (expression?.type === 'CallExpression' && containsAsyncModifier(expression)) {
          context.report({ node, messageId: 'unhandled' })
        }
      },
    }
  },
}
