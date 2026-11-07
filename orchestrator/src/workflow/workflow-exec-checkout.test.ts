import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowExecCheckoutRefusal, workflowExecCommandCwd } from './workflow-exec-checkout.ts'

const checkout = '/projects/app'

test('a mismatched child --cwd refuses with the exact remedy', () => {
  const command = [PLATFORM_SLUG, 'pr', 'create', '--cwd', '/projects/worktree', '--title', 'Fix']
  expect(
    workflowExecCheckoutRefusal(command, checkout, '/projects/worktree', '/projects/worktree'),
  ).toBe(
    `workflow exec runs in /projects/app but the command names --cwd /projects/worktree; run it as: ${PLATFORM_SLUG} workflow exec --cwd /projects/worktree -- ${PLATFORM_SLUG} pr create --cwd /projects/worktree --title Fix`,
  )
})

test('a mismatched child --cwd=<dir> refuses with the same remedy', () => {
  const command = ['bun', 'run', '--cwd=/projects/worktree', 'check']
  expect(
    workflowExecCheckoutRefusal(command, checkout, '/projects/worktree', '/projects/worktree'),
  ).toBe(
    `workflow exec runs in /projects/app but the command names --cwd /projects/worktree; run it as: ${PLATFORM_SLUG} workflow exec --cwd /projects/worktree -- bun run --cwd=/projects/worktree check`,
  )
})

test('a matching child --cwd passes', () => {
  expect(
    workflowExecCheckoutRefusal(
      [PLATFORM_SLUG, 'pr', 'create', '--cwd', checkout],
      checkout,
      checkout,
      checkout,
    ),
  ).toBeNull()
})

test('a child without --cwd passes', () => {
  expect(workflowExecCheckoutRefusal(['bun', 'run', 'check'], checkout, null, null)).toBeNull()
})

test('a child --cwd after its bare separator is ignored', () => {
  expect(
    workflowExecCheckoutRefusal(
      ['bun', 'run', 'script', '--', '--cwd', '/projects/worktree'],
      checkout,
      null,
      null,
    ),
  ).toBeNull()
})

test('the last child --cwd before the separator decides', () => {
  expect(
    workflowExecCommandCwd(['bun', '--cwd', '/first', '--cwd=/last', '--', '--cwd', '/ignored']),
  ).toBe('/last')
})

test('the remedy shell-quotes a command argument containing a space', () => {
  const command = ['bun', 'run', '--cwd', '/projects/worktree', 'check all']
  expect(
    workflowExecCheckoutRefusal(command, checkout, '/projects/worktree', '/projects/worktree'),
  ).toBe(
    `workflow exec runs in /projects/app but the command names --cwd /projects/worktree; run it as: ${PLATFORM_SLUG} workflow exec --cwd /projects/worktree -- bun run --cwd /projects/worktree 'check all'`,
  )
})
