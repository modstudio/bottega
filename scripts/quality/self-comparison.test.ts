import { expect, test } from 'bun:test'
import { Linter } from 'eslint'
import { selfComparisonRule } from './self-comparison'

function messages(source: string) {
  const linter = new Linter()
  return linter.verify(source, {
    languageOptions: { ecmaVersion: 'latest' },
    plugins: { local: { rules: { 'self-comparison': selfComparisonRule } } },
    rules: { 'local/self-comparison': 'error' },
  })
}

test('self-comparison flags identical expression text', () => {
  expect(messages('expect(subject.value).toEqual(subject.value)')).toHaveLength(1)
})

test('self-comparison accepts different expression text', () => {
  expect(messages('expect(subject.value).toEqual(expected.value)')).toEqual([])
})
