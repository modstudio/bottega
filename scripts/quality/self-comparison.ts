import type { Rule } from 'eslint'

const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual'])

function propertyName(node: Rule.Node): string | undefined {
  if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier')
    return
  return node.property.name
}

function expectArgument(node: Rule.Node): Rule.Node | undefined {
  let current = node
  while (current.type === 'MemberExpression') current = current.object as Rule.Node
  if (
    current.type !== 'CallExpression' ||
    current.callee.type !== 'Identifier' ||
    current.callee.name !== 'expect'
  )
    return
  const argument = current.arguments[0]
  return argument?.type === 'SpreadElement' ? undefined : (argument as Rule.Node | undefined)
}

export const selfComparisonRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      selfComparison: 'Compare the received value with a different expression.',
    },
  },
  create(context) {
    const source = context.sourceCode
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return
        const matcher = propertyName(node.callee as Rule.Node)
        if (!matcher || !EQUALITY_MATCHERS.has(matcher)) return
        const received = expectArgument(node.callee.object as Rule.Node)
        const expected = node.arguments[0]
        if (!received || !expected || expected.type === 'SpreadElement') return
        if (source.getText(received) !== source.getText(expected as Rule.Node)) return
        context.report({ node, messageId: 'selfComparison' })
      },
    }
  },
}
