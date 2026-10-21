import { expect, test } from 'bun:test'
import { analyzePreview, analyzeStoryTodos } from './check-storybook.ts'

test('requires the global accessibility audit to fail on violations', () => {
  expect(
    analyzePreview(
      "const preview = { parameters: { a11y: { test: 'error' } } }; export default preview",
    ),
  ).toEqual([])
  expect(
    analyzePreview(
      "const decoy = { parameters: { a11y: { test: 'error' } } }; const preview = { parameters: { a11y: { test: 'todo' } } }; export default preview",
    ),
  ).toHaveLength(1)
})

test('requires a one-line reason for each story accessibility exception', () => {
  const withoutReason = "export const Example = { parameters: { a11y: { test: 'todo' } } }"
  expect(analyzeStoryTodos(withoutReason, 'example.stories.tsx').violations).toHaveLength(1)
  const withReason =
    "export const Example = { parameters: { a11y: { // a11y todo: upstream browser defect\n test: 'todo' } } }"
  expect(analyzeStoryTodos(withReason, 'example.stories.tsx')).toEqual({ count: 1, violations: [] })
  expect(
    analyzeStoryTodos(
      "export const Example = { parameters: { a11y: { test: 'off' } } }",
      'example.stories.tsx',
    ).violations,
  ).toHaveLength(1)
  expect(
    analyzeStoryTodos(
      'export const Example = { parameters: { a11y: { disable: true } } }',
      'example.stories.tsx',
    ).violations,
  ).toHaveLength(1)
})
