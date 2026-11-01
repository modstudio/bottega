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
})
