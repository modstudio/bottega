import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { renderClassMeasurementCommand } from '../workflow/workflow-class-measured-floor.ts'
import { decidePullRequestClassGuard } from './pr-class-guard.ts'

const command = renderClassMeasurementCommand(['sh', '-c', 'rg leak | wc -l'])!
const base = {
  body: 'Summary\nClass guard: architecture check (before 3, after 0)',
  measurement: { className: 'reader leak', command, count: 3 },
  implementClosedAt: '2026-11-24T10:00:00Z',
  execs: [
    {
      command,
      cwd: '/tree',
      output: '0\n',
      exitCode: 0,
      createdAt: '2026-11-24T10:01:00Z',
    },
  ],
  worktree: '/tree',
  checkoutRoots: [],
}

test('allows a matching class guard', () =>
  expect(decidePullRequestClassGuard(base)).toEqual({ kind: 'allow' }))
test('refuses a post-implement measurement from the main checkout and names the worktree', () => {
  const decision = decidePullRequestClassGuard({
    ...base,
    execs: [{ ...base.execs[0]!, cwd: '/main' }],
  })
  expect(decision).toEqual({
    kind: 'refuse',
    message: expect.stringContaining('/tree'),
  })
})
test('allows a post-implement measurement from the worktree', () =>
  expect(
    decidePullRequestClassGuard({
      ...base,
      execs: [{ ...base.execs[0]!, cwd: '/main' }, base.execs[0]!],
    }),
  ).toEqual({ kind: 'allow' }))
test('refuses a cursor with no worktree', () => {
  const decision = decidePullRequestClassGuard({ ...base, worktree: undefined })
  expect(decision).toEqual({ kind: 'refuse', message: expect.stringContaining('--arg worktree') })
  expect(decision).toEqual({
    kind: 'refuse',
    message: expect.stringContaining(
      `run \`${PLATFORM_SLUG} pr create\` from the branch's worktree`,
    ),
  })
})
test('does not apply without a class measurement', () => {
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

test('quotes a spaced worktree and shell command as one rerunnable invocation', () => {
  const measuredCommand = renderClassMeasurementCommand(['sh', '-c', "rg 'reader leak' | wc -l"])!
  const decision = decidePullRequestClassGuard({
    ...base,
    measurement: { ...base.measurement, command: measuredCommand },
    execs: [],
    worktree: '/tree with space',
  })
  expect(decision).toEqual({
    kind: 'refuse',
    message: `the Class guard has no successful post-implement measurement; run \`${PLATFORM_SLUG} workflow exec --cwd '/tree with space' -- 'sh' '-c' 'rg '\\''reader leak'\\'' | wc -l'\``,
  })
})

test('allows a tree-relative rerun of a recorded command that names a checkout', () => {
  const checkout = '/Users/shmuel/Projects/bottega'
  const recorded = renderClassMeasurementCommand(['bun', '/private/tmp/measure.ts', checkout])!
  const relative = renderClassMeasurementCommand(['bun', '/private/tmp/measure.ts', '.'])!
  expect(
    decidePullRequestClassGuard({
      ...base,
      measurement: { ...base.measurement, command: recorded, count: 4 },
      body: 'Class guard: example class (before 4, after 0)',
      execs: [{ ...base.execs[0]!, command: relative }],
      checkoutRoots: [checkout],
    }),
  ).toEqual({ kind: 'allow' })
})

test('refuses a tree-relative rerun outside the worktree', () => {
  const checkout = '/Users/shmuel/Projects/bottega'
  const recorded = renderClassMeasurementCommand(['bun', '/private/tmp/measure.ts', checkout])!
  const relative = renderClassMeasurementCommand(['bun', '/private/tmp/measure.ts', '.'])!
  expect(
    decidePullRequestClassGuard({
      ...base,
      measurement: { ...base.measurement, command: recorded },
      execs: [{ ...base.execs[0]!, command: relative, cwd: '/main' }],
      checkoutRoots: [checkout],
    }),
  ).toEqual({ kind: 'refuse', message: expect.stringContaining('did not run in worktree') })
})

test('the rerun remedy names only the tree-relative credited command', () => {
  const checkout = '/Users/shmuel/Projects/bottega'
  const recorded = renderClassMeasurementCommand(['bun', '/private/tmp/measure.ts', checkout])!
  const decision = decidePullRequestClassGuard({
    ...base,
    measurement: { ...base.measurement, command: recorded },
    execs: [],
    checkoutRoots: [checkout],
  })
  expect(decision).toEqual({ kind: 'refuse', message: expect.stringContaining("'.'") })
  if (decision.kind === 'refuse') expect(decision.message).not.toContain(checkout)
})

test('a recorded command naming no checkout keeps its original matching behavior', () => {
  expect(decidePullRequestClassGuard(base)).toEqual({ kind: 'allow' })
  expect(
    decidePullRequestClassGuard({ ...base, execs: [{ ...base.execs[0]!, command: "'other'" }] }),
  ).toEqual({ kind: 'refuse', message: expect.stringContaining(command) })
})
