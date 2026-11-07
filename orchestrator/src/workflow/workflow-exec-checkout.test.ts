import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowExecCheckoutRefusal } from './workflow-exec-checkout.ts'

const checkout = '/projects/app'

test('a mismatched child --cwd refuses with the exact remedy', () => {
  const command = [PLATFORM_SLUG, 'pr', 'create', '--cwd', '/projects/worktree', '--title', 'Fix']
  expect(workflowExecCheckoutRefusal(command, checkout, '/projects/worktree')).toBe(
    `workflow exec runs in /projects/app but the command names --cwd /projects/worktree; run it as: ${PLATFORM_SLUG} workflow exec --cwd /projects/worktree -- ${PLATFORM_SLUG} pr create --cwd /projects/worktree --title Fix`,
  )
})

test('a mismatched child --cwd=<dir> refuses with the same remedy', () => {
  const command = ['bun', 'run', '--cwd=/projects/worktree', 'check']
  expect(workflowExecCheckoutRefusal(command, checkout, '/projects/worktree')).toBe(
    `workflow exec runs in /projects/app but the command names --cwd /projects/worktree; run it as: ${PLATFORM_SLUG} workflow exec --cwd /projects/worktree -- bun run --cwd=/projects/worktree check`,
  )
})

test('a matching child --cwd passes', () => {
  expect(
    workflowExecCheckoutRefusal(
      [PLATFORM_SLUG, 'pr', 'create', '--cwd', checkout],
      checkout,
      checkout,
    ),
  ).toBeNull()
})

test('a relative child --cwd dot passes when it resolves to the exec checkout', () => {
  expect(
    workflowExecCheckoutRefusal(['bun', 'run', '--cwd', '.', 'check'], checkout, checkout),
  ).toBeNull()
})

test('a child without --cwd passes', () => {
  expect(workflowExecCheckoutRefusal(['bun', 'run', 'check'], checkout, null)).toBeNull()
})

test('a child --cwd after its bare separator is ignored', () => {
  expect(
    workflowExecCheckoutRefusal(
      ['bun', 'run', 'script', '--', '--cwd', '/projects/worktree'],
      checkout,
      '/projects/worktree',
    ),
  ).toBeNull()
})
