import { expect, test } from 'bun:test'
import { decidePullRequestClassGuard } from './pr-class-guard.ts'

const base = {
  applies: true,
  body: 'Summary\nClass guard: architecture check (before 3, after 0)',
  measurement: { className: 'reader leak', command: 'rg leak | wc -l', count: 3 },
  implementClosedAt: '2026-11-24T10:00:00Z',
  execs: [
    {
      command: 'rg leak | wc -l',
      output: '0\n',
      exitCode: 0,
      createdAt: '2026-11-24T10:01:00Z',
    },
  ],
  worktree: '/tree',
}

test('allows a matching class guard', () =>
  expect(decidePullRequestClassGuard(base)).toEqual({ kind: 'allow' }))
test('does not apply without measure-class or outside fix-defect', () => {
  expect(decidePullRequestClassGuard({ ...base, applies: false, body: '' }).kind).toBe('allow')
  expect(decidePullRequestClassGuard({ ...base, measurement: undefined, body: '' }).kind).toBe(
    'allow',
  )
})
test.each([
  ['no line', { body: '' }, 'missing'],
  ['no guard', { body: 'Class guard:  (before 3, after 0)' }, 'guard name'],
  ['before mismatch', { body: 'Class guard: check (before 2, after 0)' }, 'before count'],
  ['no after exec', { execs: [] }, 'no successful post-implement'],
  ['after mismatch', { body: 'Class guard: check (before 3, after 1)' }, 'after count'],
])('%s refuses', (_name, overrides, message) => {
  expect(decidePullRequestClassGuard({ ...base, ...overrides })).toMatchObject({
    kind: 'refuse',
    message: expect.stringContaining(message),
  })
})
