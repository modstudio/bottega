import { describe, expect, test } from 'bun:test'
import { namingFindings } from './naming-rule.ts'

describe('record naming rule', () => {
  test.each(['the operator said', 'Operator rulings', "operator's call", 'ask the operators'])(
    'refuses the role sense in %s',
    (text) => {
      expect(namingFindings(text, null)).toHaveLength(1)
    },
  )

  test.each([
    '- operator approved the plan',
    '* Operator ruled on it',
    '> operator said yes',
    '  - operator approved the plan',
    '  * Operator ruled on it',
    '  > operator said yes',
  ])('refuses a Markdown marker as the role sense in %s', (text) => {
    expect(namingFindings(text, null)).toHaveLength(1)
  })

  test.each([
    'The plan is ready. Operator approved it.',
    'Is it ready? Operator says yes.',
    'Done! Operator ruled.',
  ])('refuses sentence punctuation followed by the role sense in %s', (text) => {
    expect(namingFindings(text, null)).toHaveLength(1)
  })

  test.each([
    'the ... operator',
    'the && operator',
    '&& operator',
    'a + operator',
    'the `IN` operator',
    'comparison operators',
    'a ternary operator',
    '`--from-operator`',
    'the spread operator',
  ])('allows the programming sense in %s', (text) => {
    expect(namingFindings(text, null)).toEqual([])
  })

  test('names the supplied person in the remedy', () => {
    expect(namingFindings('the operator decided', 'Shmuel Barkin')[0]?.message).toBe(
      'Name the person: Shmuel Barkin; where a role word is needed, use "the user".',
    )
  })

  test('uses the generic remedy without a display name', () => {
    expect(namingFindings('the operator decided', null)[0]?.message).toBe(
      'Name the person who decided; where a role word is needed, use "the user".',
    )
  })

  test.each([
    ['the operator', null, 'the operator', 'the user'],
    ['The operator', null, 'The operator', 'The user'],
    ['an operator', null, 'an operator', 'the user'],
    ["the operator's", null, "the operator's", "the user's"],
    ['the operator', 'Shmuel Barkin', 'the operator', 'Shmuel Barkin'],
    ['operator', null, 'operator', 'the user'],
  ])('replaces the complete role phrase in %s', (text, displayName, problem, suggestion) => {
    expect(namingFindings(text, displayName)).toEqual([
      expect.objectContaining({ text: problem, suggestions: [suggestion] }),
    ])
  })
})
